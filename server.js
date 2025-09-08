// server.js
import express from "express";
import bodyParser from "body-parser";
import handler from "./api/scraper.js";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("FarOfertas scraper OK"));
app.post("/api/scraper", (req, res) => handler(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FarOfertas scraper listening on :${PORT}`));
