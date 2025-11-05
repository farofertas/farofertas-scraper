// server.js
import express from "express";
import bodyParser from "body-parser";
import handler from "./api/scraper.js";
import productsHandler from "./api/products.js"; // <--- NOVO

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// (opcional) proteção simples por API Key nas rotas
app.use((req, res, next) => {
  const required = process.env.API_KEY;
  if (!required) return next();
  if (req.get("X-API-Key") !== required) return res.status(401).json({ error: "unauthorized" });
  next();
});

// healthcheck
app.get("/", (_req, res) => res.status(200).send("FarOfertas scraper OK"));

// endpoints existentes
app.post("/api/scraper", (req, res) => handler(req, res));

// NOVO endpoint do FEED (GET)
app.get("/api/products", (req, res) => productsHandler(req, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FarOfertas scraper listening on :${PORT}`));
