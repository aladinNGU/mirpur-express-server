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
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });

    // All parcels OR parcels by user (createdBy), sorted by latest
    app.get("parcels", async (req, res) => {
      try {
        const userEmail = req.body.email;
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

    app.get("/payments", verifyFBToken, async (req, res) => {
      // console.log("headers in payments", req.headers);

      try {
        const userEmail = req.query.email;

        console.log("Email-1", req.decoded.email);
        console.log("Email-2", userEmail);

        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "forbidden access" });
        }

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
