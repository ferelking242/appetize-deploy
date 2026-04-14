import { Router, type IRouter } from "express";
import healthRouter from "./health";
import appetizeRouter from "./appetize";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/appetize", appetizeRouter);

export default router;
