const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

// Load env variables from .env file
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

/* ---------------- Middlewares ---------------- */

app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* ---------------- MongoDB Connection ---------------- */

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.zn6isea.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const trackingCollection = db.collection("trackings");
    const userCollection = db.collection("users");
    const riderCollection = db.collection("riders");
    const cashoutCollection = db.collection("cashouts");

    // customs middlewares
    const verifyFBToken = async (req, res, next) => {
      // console.log("header in middleware", req.headers);
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.get("/users/search", async (req, res) => {
      try {
        const search = req.query.search;

        if (!search) {
          return res.send([]); // return empty if no search
        }

        const query = {
          email: { $regex: search, $options: "i" },
        };

        const users = await userCollection
          .find(query)
          .project({
            email: 1,
            role: 1,
            createdAt: 1,
          })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        console.error("User search error:", error);
        res.status(500).send({ message: "Failed to search users" });
      }
    });

    app.patch(
      "/users/make-admin/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                role: "admin",
              },
            },
          );

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to make admin" });
        }
      },
    );

    app.patch("/users/revoke-admin/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              role: "user",
            },
          },
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to revoke admin" });
      }
    });

    app.get("/users/role", async (req, res) => {
      try {
        const { email } = req.query;

        // 1️⃣ Validate email
        if (!email) {
          return res.status(400).json({
            success: false,
            message: "Email query parameter is required",
          });
        }

        // 2️⃣ Find user
        const user = await userCollection.findOne(
          { email },
          { projection: { role: 1 } }, // only fetch role
        );

        // 3️⃣ If user not found → default role
        if (!user) {
          return res.status(200).json({
            success: true,
            role: "user",
          });
        }

        // 4️⃣ Return role
        return res.status(200).json({
          success: true,
          role: user.role || "user",
        });
      } catch (error) {
        console.error("Get user role error:", error);
        return res.status(500).json({
          success: false,
          message: "Internal server error",
        });
      }
    });

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await userCollection.findOne({ email });
      if (userExists) {
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { createdBy: userEmail } : {};
        const options = {
          sort: { creationDate: -1 },
        };
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    app.get("/parcels/assignable", async (req, res) => {
      try {
        const parcels = await parcelCollection
          .find({
            paymentStatus: "paid",
            deliveryStatus: "not_collected",
          })
          .toArray();

        res.send(parcels);
      } catch (error) {
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // Get all pending deliveries
    app.get("/riders/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;
        console.log(email);

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Rider email is required",
          });
        }

        const query = {
          riderEmail: email,
          deliveryStatus: {
            $in: ["Rider assigned", "In transit"],
          },
        };

        const parcels = await parcelCollection
          .find(query)
          .sort({ creationDate: -1 }) // newest first
          .toArray();

        res.status(200).send({
          success: true,
          total: parcels.length,
          data: parcels,
        });
      } catch (error) {
        console.error("Error fetching rider pending parcels:", error);
        res.status(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    });

    app.get(
      "/riders/completed-parcels",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const { email } = req.query;

          if (!email) {
            return res.status(400).send({
              success: false,
              message: "Rider email is required",
            });
          }

          const query = {
            riderEmail: email,
            deliveryStatus: {
              $in: ["Delivery Completed", "SC Delivered"],
            },
          };

          const parcels = await parcelCollection
            .find(query)
            .sort({ creationDate: -1 }) // newest first
            .toArray();

          res.status(200).send({
            success: true,
            total: parcels.length,
            data: parcels,
          });
        } catch (error) {
          console.error("Error fetching completed parcels:", error);
          res.status(500).send({
            success: false,
            message: "Internal server error",
          });
        }
      },
    );

    // Update delivery status
    app.patch("/parcels/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        const allowedStatuses = ["In transit", "Delivery Completed"];

        if (!allowedStatuses.includes(status)) {
          return res.status(400).send({
            success: false,
            message: "Invalid status update",
          });
        }

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { deliveryStatus: status } },
        );

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        res.status(500).send({ success: false });
      }
    });

    // app.patch("/parcels/:id/cashout", async (req, res) => {
    //   const id = req.params.id;
    //   const result = await parcelCollection.updateOne(
    //     { _id: new ObjectId(id) },
    //     { $set: { cashoutStatus: "cash out", cashedAt: new Date() } },
    //   );
    //   res.send(result);
    // });

    app.patch("/parcels/assign/:id", async (req, res) => {
      try {
        const { riderId, riderEmail, riderName } = req.body;
        const id = req.params.id;

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              riderId,
              riderEmail,
              riderName,
              deliveryStatus: "Rider assigned",
            },
          },
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Assign failed" });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const parcel = await parcelCollection.findOne(query);
        res.send(parcel);
      } catch (error) {
        console.error("Get parcel error:", error);
        res.status(500).send({ message: "Failed to fetch parcel" });
      }
    });

    // GET riders by district
    app.get("/riders", async (req, res) => {
      try {
        const { district } = req.query;

        if (!district) {
          return res.status(400).send({ message: "District is required" });
        }

        const riders = await riderCollection.find({ district }).toArray();

        res.send(riders);
      } catch (error) {
        res.status(500).send({ message: "Failed to get riders" });
      }
    });

    app.post("/riders", async (req, res) => {
      const email = req.query.email;

      const existing = await riderCollection.findOne({ email });

      if (existing) {
        return res.status(400).send({ message: "You have already applied." });
      }

      const result = await riderCollection.insertOne(req.body);
      res.send(result);
    });

    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await riderCollection
          .find({ status: "pending" })
          .sort({ appliedAt: -1 })
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to fetch pending riders:", error);
        res.status(500).send({ message: "Failed to get pending riders" });
      }
    });

    app.patch("/riders/:id/approve", async (req, res) => {
      try {
        const id = req.params.id;

        // 1️⃣ Update rider status
        const riderUpdateResult = await riderCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "active",
              approvedAt: new Date(),
            },
          },
        );

        if (riderUpdateResult.modifiedCount === 0) {
          return res.status(404).send({ message: "Rider not found" });
        }

        // 2️⃣ Get rider info to access email
        const rider = await riderCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!rider?.email) {
          return res.status(400).send({ message: "Rider email not found" });
        }

        // 3️⃣ Update user role
        const roleResult = await userCollection.updateOne(
          { email: rider.email },
          {
            $set: {
              role: "rider",
            },
          },
        );

        res.send({
          success: true,
          riderUpdated: riderUpdateResult.modifiedCount,
          roleUpdated: roleResult.modifiedCount,
        });
      } catch (error) {
        console.error("Approve rider error:", error);
        res.status(500).send({ message: "Failed to approve rider" });
      }
    });

    app.patch("/riders/:id/reject", async (req, res) => {
      const id = req.params.id;

      await riderCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } },
      );

      res.send({ success: true });
    });

    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const search = req.query.search || "";

        const query = {
          status: "active",
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } },
          ],
        };

        const riders = await riderCollection
          .find(query)
          .sort({ approvedAt: -1 })
          .toArray();

        res.send(riders);
      } catch (error) {
        res.status(500).send({ message: "Failed to get active riders" });
      }
    });

    app.patch("/riders/deactivate/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await riderCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "deactivate",
              deactivatedAt: new Date(),
            },
          },
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to deactivate rider" });
      }
    });

    // Delete rider
    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const result = await riderCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Update rider
    app.patch("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;

      const result = await riderCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData },
      );

      res.send(result);
    });

    app.post("/tracking", async (req, res) => {
      const {
        trackingId,
        parcelId,
        status,
        message,
        updatedBy = "",
      } = req.body;

      const log = {
        trackingId,
        parcelId: parcelId ? new ObjectId(parcelId) : undefined,
        status,
        message,
        timestamp: new Date(),
        updatedBy,
      };

      const result = await trackingCollection.insertOne(log);

      res.send({ success: true, insertedId: result.insertedId });
    });

    app.get("/payments", async (req, res) => {
      // console.log("headers in payments", req.headers);
      try {
        const userEmail = req.query.email;

        // console.log(userEmail);
        // console.log("decoded", req.decoded.email);

        // if (req.decoded.email !== userEmail) {
        //   return res.status(403).send({ message: "forbidden access" });
        // }

        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paidAt: -1 } };

        const payments = await paymentCollection.find(query, options).toArray();

        res.send(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    // Record payment and update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, transactionId, email } = req.body;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        if (!email) {
          return res.status(400).send({ message: "User email required" });
        }

        // 🔍 Find parcel
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        // 🔒 Ensure parcel belongs to that email
        if (parcel.createdBy !== email) {
          return res
            .status(403)
            .send({ message: "Unauthorized payment attempt" });
        }

        // ✅ Prevent double payment
        if (parcel.paymentStatus === "paid") {
          return res.status(400).send({ message: "Parcel already paid" });
        }

        // ✅ Verify payment from Stripe (VERY IMPORTANT)
        const paymentIntent =
          await stripe.paymentIntents.retrieve(transactionId);

        if (paymentIntent.status !== "succeeded") {
          return res.status(400).send({ message: "Payment not successful" });
        }

        // ✅ Insert payment record
        const paymentDoc = {
          parcelId: new ObjectId(parcelId),
          transactionId,
          amount: paymentIntent.amount / 100, // trusted from Stripe
          currency: paymentIntent.currency,
          paidBy: email,
          paidAt: new Date(),
          paidAtString: new Date().toISOString(),
        };

        const paymentResult = await paymentCollection.insertOne(paymentDoc);

        // ✅ Update parcel
        await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: { paymentStatus: "paid" },
          },
        );

        res.send({
          success: true,
          paymentId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment save error:", error);
        res.status(500).send({ message: "Failed to save payment" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    // DELETE parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error("Delete error:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    ////////////////////////////////////////////////////////////

    // Request cashout
    app.post(
      "/riders/cashout",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const { email, amount, riderName } = req.body;

          if (!email || !amount || !riderName) {
            return res.status(400).send({
              success: false,
              message: "Missing required fields",
            });
          }

          // Check if rider has any pending cashout requests
          const pendingCashout = await cashoutCollection.findOne({
            riderEmail: email,
            status: "Pending",
          });

          if (pendingCashout) {
            return res.status(400).send({
              success: false,
              message: "You already have a pending cashout request",
            });
          }

          // Calculate total completed deliveries earnings
          const completedParcels = await parcelCollection
            .find({
              riderEmail: email,
              deliveryStatus: { $in: ["Delivery Completed", "SC Delivered"] },
            })
            .toArray();

          // Calculate earnings (reusing your calculation logic)
          const calculateEarning = (parcel) => {
            const isSameDistrict =
              parcel.senderDistrict === parcel.receiverDistrict;
            const percentage = isSameDistrict ? 0.8 : 0.3;
            return (parcel.deliveryCharge || 0) * percentage;
          };

          const totalEarnings = completedParcels.reduce(
            (sum, parcel) => sum + calculateEarning(parcel),
            0,
          );

          // Check if requested amount is valid
          if (amount > totalEarnings) {
            return res.status(400).send({
              success: false,
              message: `Insufficient balance. Available: ৳${totalEarnings.toFixed(2)}`,
            });
          }

          if (amount < 100) {
            return res.status(400).send({
              success: false,
              message: "Minimum cashout amount is ৳100",
            });
          }

          // Create cashout request
          const cashoutRequest = {
            riderEmail: email,
            riderName,
            amount: parseFloat(amount),
            status: "Pending",
            requestDate: new Date(),
            processedDate: null,
            transactionId: null,
            notes: "",
          };

          const result = await cashoutCollection.insertOne(cashoutRequest);

          res.status(201).send({
            success: true,
            message: "Cashout request submitted successfully",
            data: { ...cashoutRequest, _id: result.insertedId },
          });
        } catch (error) {
          console.error("Error processing cashout request:", error);
          res.status(500).send({
            success: false,
            message: "Internal server error",
          });
        }
      },
    );

    // Get rider's cashout history
    app.get(
      "/riders/cashout-history",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const { email } = req.query;

          if (!email) {
            return res.status(400).send({
              success: false,
              message: "Rider email is required",
            });
          }

          const cashouts = await cashoutCollection
            .find({ riderEmail: email })
            .sort({ requestDate: -1 })
            .toArray();

          res.status(200).send({
            success: true,
            data: cashouts,
          });
        } catch (error) {
          console.error("Error fetching cashout history:", error);
          res.status(500).send({
            success: false,
            message: "Internal server error",
          });
        }
      },
    );

    // Get rider's current balance
    app.get("/riders/balance", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Rider email is required",
          });
        }

        // Get all completed parcels
        const completedParcels = await parcelCollection
          .find({
            riderEmail: email,
            deliveryStatus: { $in: ["Delivery Completed", "SC Delivered"] },
          })
          .toArray();

        // Calculate earnings
        const calculateEarning = (parcel) => {
          const isSameDistrict =
            parcel.senderDistrict === parcel.receiverDistrict;
          const percentage = isSameDistrict ? 0.8 : 0.3;
          return (parcel.deliveryCharge || 0) * percentage;
        };

        const totalEarnings = completedParcels.reduce(
          (sum, parcel) => sum + calculateEarning(parcel),
          0,
        );

        // Get total cashouted amount
        const cashoutedAmount = await cashoutCollection
          .aggregate([
            {
              $match: {
                riderEmail: email,
                status: { $in: ["Completed", "Pending"] },
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: "$amount" },
              },
            },
          ])
          .toArray();

        const totalCashouted = cashoutedAmount[0]?.total || 0;

        // Current balance = total earnings - total cashouted
        const currentBalance = totalEarnings - totalCashouted;

        // Check pending cashout
        const pendingCashout = await cashoutCollection.findOne({
          riderEmail: email,
          status: "Pending",
        });

        res.status(200).send({
          success: true,
          data: {
            totalEarnings,
            totalCashouted,
            currentBalance,
            hasPendingCashout: !!pendingCashout,
            pendingCashoutAmount: pendingCashout?.amount || 0,
          },
        });
      } catch (error) {
        console.error("Error fetching rider balance:", error);
        res.status(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    });

    // Admin: Get all cashout requests
    app.get(
      "/admin/cashout-requests",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { status } = req.query;
          const query = status ? { status } : {};

          const cashouts = await cashoutCollection
            .find(query)
            .sort({ requestDate: -1 })
            .toArray();

          res.status(200).send({
            success: true,
            data: cashouts,
          });
        } catch (error) {
          console.error("Error fetching cashout requests:", error);
          res.status(500).send({
            success: false,
            message: "Internal server error",
          });
        }
      },
    );

    // Admin: Process cashout request
    app.patch(
      "/admin/cashout/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status, transactionId, notes } = req.body;

          if (!["Completed", "Rejected"].includes(status)) {
            return res.status(400).send({
              success: false,
              message: "Invalid status",
            });
          }

          const updateData = {
            status,
            processedDate: new Date(),
            notes: notes || "",
          };

          if (status === "Completed" && transactionId) {
            updateData.transactionId = transactionId;
          }

          const result = await cashoutCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData },
          );

          res.status(200).send({
            success: true,
            message: `Cashout request ${status.toLowerCase()}`,
            modifiedCount: result.modifiedCount,
          });
        } catch (error) {
          console.error("Error processing cashout request:", error);
          res.status(500).send({
            success: false,
            message: "Internal server error",
          });
        }
      },
    );

    ////////////////////////////////////////////////////////

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const amount = req.body.amount;

        // ✅ Basic validation
        if (!amount || amount <= 0) {
          return res.status(400).send({ message: "Invalid amount" });
        }

        // ✅ Convert to cents (Stripe requires smallest currency unit)
        const amountInCents = Math.round(amount * 100);

        // ✅ Create PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd", // change if needed
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(500).send({ message: "Failed to create payment intent" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

/* ---------------- Routes ---------------- */

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Parcel Server is Running");
});
/* ---------------- Start Server ---------------- */

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
