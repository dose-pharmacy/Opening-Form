import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
    try {
        const { migrationId } = (req.params as any);
        const stocks = await prisma.openingStock.findMany({
            where: { migrationId },
            include: { batch: true, location: true, product: true }
        });
        res.json(stocks);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch opening stock' });
    }
});

router.post('/', async (req, res) => {
    try {
        const { migrationId } = (req.params as any);
        const { productId, batchId, locationId, unitBreakdown, unitCost } = req.body;

        if (!productId || !batchId || !locationId || !Array.isArray(unitBreakdown)) {
            return res.status(400).json({ error: 'Missing required fields or invalid unitBreakdown' });
        }

        const product = await prisma.product.findUnique({ where: { id: productId, migrationId } });
        const batch = await prisma.batch.findUnique({ where: { id: batchId, migrationId } });
        const location = await prisma.location.findUnique({ where: { id: locationId, migrationId } });

        if (!product || !batch || !location) {
            return res.status(400).json({ error: 'Invalid references or cross-migration' });
        }

        if (batch.productId !== productId) {
            return res.status(400).json({ error: 'Batch does not belong to this product' });
        }

        // Calculate baseQuantity server-side
        let baseQuantity = 0;
        const productUnits = await prisma.productUnit.findMany({ where: { productId } });
        const unitMap = new Map(productUnits.map(pu => [pu.unitId, pu.conversionToBase]));

        for (const item of unitBreakdown) {
            const { unitId, quantity } = item;
            if (quantity < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
            if (!unitMap.has(unitId)) return res.status(400).json({ error: `Unit ${unitId} does not belong to this product` });
            baseQuantity += quantity * unitMap.get(unitId)!;
        }

        const existing = await prisma.openingStock.findUnique({
            where: { migrationId_batchId_locationId: { migrationId, batchId, locationId } }
        });

        if (existing) {
            return res.status(409).json({ error: 'Stock already exists for this batch and location' });
        }

        const stock = await prisma.openingStock.create({
            data: {
                migrationId,
                productId,
                batchId,
                locationId,
                baseQuantity,
                unitBreakdown,
                unitCost: unitCost || 0
            }
        });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.status(201).json(stock);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create stock' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        const { migrationId, id } = (req.params as any);
        const { unitBreakdown, unitCost, version } = req.body;

        if (!version) return res.status(400).json({ error: 'Base version is required' });

        const current = await prisma.openingStock.findUnique({ where: { id, migrationId } });
        if (!current) return res.status(404).json({ error: 'Stock not found' });
        if (current.version !== version) return res.status(409).json({ error: 'Stale update' });

        const updateData: any = { version: { increment: 1 } };

        if (unitBreakdown !== undefined && Array.isArray(unitBreakdown)) {
            let baseQuantity = 0;
            const productUnits = await prisma.productUnit.findMany({ where: { productId: current.productId } });
            const unitMap = new Map(productUnits.map(pu => [pu.unitId, pu.conversionToBase]));

            for (const item of unitBreakdown) {
                const { unitId, quantity } = item;
                if (quantity < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
                if (!unitMap.has(unitId)) return res.status(400).json({ error: `Unit ${unitId} does not belong to this product` });
                baseQuantity += quantity * unitMap.get(unitId)!;
            }
            updateData.unitBreakdown = unitBreakdown;
            updateData.baseQuantity = baseQuantity;
        }

        if (unitCost !== undefined) updateData.unitCost = unitCost;

        const updated = await prisma.openingStock.update({ where: { id, migrationId }, data: updateData });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update stock' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { migrationId, id } = (req.params as any);

        await prisma.openingStock.delete({ where: { id, migrationId } });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete stock' });
    }
});

export default router;
