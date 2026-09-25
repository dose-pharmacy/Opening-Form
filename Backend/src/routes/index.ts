import { Router } from 'express';
import migrationRoutes from './migrations';
import groupRoutes from './groups';
import locationRoutes from './locations';
import unitRoutes from './units';
import productRoutes from './products';
import productUnitRoutes from './productUnits';
import batchRoutes from './batches';
import openingStockRoutes from './openingStocks';
import syncRoutes from './sync';

const router = Router();

router.use('/migrations', migrationRoutes);
router.use('/migrations/:migrationId/groups', groupRoutes);
router.use('/migrations/:migrationId/locations', locationRoutes);
router.use('/migrations/:migrationId/units', unitRoutes);
router.use('/migrations/:migrationId/products', productRoutes);
router.use('/migrations/:migrationId/productUnits', productUnitRoutes);
router.use('/migrations/:migrationId/batches', batchRoutes);
router.use('/migrations/:migrationId/openingStock', openingStockRoutes);
router.use('/migrations/:migrationId/sync', syncRoutes);

export default router;
