import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { v1Router } from "./routes/appetize";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// v1 REST API
app.use("/api/v1", v1Router);

// Legacy routes
app.get("/api", (_req, res) => res.redirect("/api/dashboard/"));
app.use("/api", router);

// Dashboard static files
app.use("/api/dashboard", express.static(path.resolve(process.cwd(), "public")));
app.get("/api/dashboard", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "public", "index.html"));
});

export default app;
