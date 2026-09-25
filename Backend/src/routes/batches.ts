import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
    try {
        const { migrationId } = req.params;
        const batches = await prisma.batch.findMany({
            where: { migrationId },
            include: { product: true }
        });
        res.json(batches);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch batches' });
    }
});

router.post('/', async (req, res) => {
    try {
        const { migrationId } = req.params;
        const { productId, batchNumber, expiryDate, manufacturingDate, receivedDate, supplierReference } = req.body;

        if (!productId || !batchNumber || !expiryDate) {
            return res.status(400).json({ error: 'productId, batchNumber, and expiryDate are required' });
        }

        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (!product || product.migrationId !== migrationId) {
            return res.status(400).json({ error: 'Product not found or cross-migration reference' });
        }

        const parsedExpiry = new Date(expiryDate);
        if (isNaN(parsedExpiry.getTime())) {
            return res.status(400).json({ error: 'Invalid expiryDate' });
        }

        const existing = await prisma.batch.findUnique({
            where: { migrationId_productId_batchNumber: { migrationId, productId, batchNumber: batchNumber.trim() } }
        });

        if (existing) {
            return res.status(409).json({ error: 'Batch number already exists for this product' });
        }

        const batch = await prisma.batch.create({
            data: {
                migrationId,
                productId,
                batchNumber: batchNumber.trim(),
                expiryDate: parsedExpiry,
                manufacturingDate: manufacturingDate ? new Date(manufacturingDate) : null,
                receivedDate: receivedDate ? new Date(receivedDate) : null,
                supplierReference
            }
        });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.status(201).json(batch);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create batch' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        const { migrationId, id } = req.params;
        const { batchNumber, expiryDate, manufacturingDate, receivedDate, supplierReference, version } = req.body;

        if (!version) return res.status(400).json({ error: 'Base version is required' });

        const current = await prisma.batch.findUnique({ where: { id, migrationId } });
        if (!current) return res.status(404).json({ error: 'Batch not found' });
        if (current.version !== version) return res.status(409).json({ error: 'Stale update' });

        const updateData: any = { version: { increment: 1 } };
        if (batchNumber) updateData.batchNumber = batchNumber.trim();
        if (expiryDate !== undefined) updateData.expiryDate = expiryDate ? new Date(expiryDate) : null;
        if (manufacturingDate !== undefined) updateData.manufacturingDate = manufacturingDate ? new Date(manufacturingDate) : null;
        if (receivedDate !== undefined) updateData.receivedDate = receivedDate ? new Date(receivedDate) : null;
        if (supplierReference !== undefined) updateData.supplierReference = supplierReference;

        const updated = await prisma.batch.update({ where: { id, migrationId }, data: updateData });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.json(updated);
    } catch (error: any) {
        if (error.code === 'P2002') return res.status(409).json({ error: 'Batch number already exists for this product' });
        res.status(500).json({ error: 'Failed to update batch' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { migrationId, id } = req.params;

        const stockCount = await prisma.openingStock.count({ where: { batchId: id } });
        if (stockCount > 0) return res.status(409).json({ error: 'Cannot delete batch because it is referenced by stock.' });

        await prisma.batch.delete({ where: { id, migrationId } });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete batch' });
    }
});

export default router;
