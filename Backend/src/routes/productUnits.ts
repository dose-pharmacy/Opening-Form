import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
    try {
        const { migrationId } = (req.params as any);
        const productUnits = await prisma.productUnit.findMany({
            where: { product: { migrationId } },
            include: { unit: true }
        });
        res.json(productUnits);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch product units' });
    }
});

router.post('/', async (req, res) => {
    try {
        const { migrationId } = (req.params as any);
        const { productId, unitId, conversionToBase, isBaseUnit, sellPrice, purchasePrice } = req.body;

        if (!productId || !unitId || conversionToBase === undefined) {
            return res.status(400).json({ error: 'productId, unitId, and conversionToBase are required' });
        }

        if (conversionToBase <= 0) {
            return res.status(400).json({ error: 'conversionToBase must be > 0' });
        }
        
        if (isBaseUnit && conversionToBase !== 1) {
            return res.status(400).json({ error: 'base unit conversionToBase must be 1' });
        }

        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (!product || product.migrationId !== migrationId) return res.status(400).json({ error: 'Invalid product or cross-migration' });

        const unit = await prisma.unit.findUnique({ where: { id: unitId } });
        if (!unit || unit.migrationId !== migrationId) return res.status(400).json({ error: 'Invalid unit or cross-migration' });

        // Transaction for safety
        const result = await prisma.$transaction(async (tx) => {
            if (isBaseUnit) {
                const existingBase = await tx.productUnit.findFirst({
                    where: { productId, isBaseUnit: true }
                });
                if (existingBase) {
                    throw new Error('MULTIPLE_BASE_UNITS');
                }
            }

            const existing = await tx.productUnit.findUnique({
                where: { productId_unitId: { productId, unitId } }
            });

            if (existing) {
                throw new Error('DUPLICATE_UNIT');
            }

            const pu = await tx.productUnit.create({
                data: { productId, unitId, conversionToBase, isBaseUnit: isBaseUnit || false, sellPrice, purchasePrice }
            });

            await tx.migration.update({
                where: { id: migrationId },
                data: { revision: { increment: 1 } }
            });

            return pu;
        });

        res.status(201).json(result);
    } catch (error: any) {
        if (error.message === 'MULTIPLE_BASE_UNITS') return res.status(409).json({ error: 'A base unit already exists for this product' });
        if (error.message === 'DUPLICATE_UNIT') return res.status(409).json({ error: 'This unit is already configured for this product' });
        res.status(500).json({ error: 'Failed to create product unit' });
    }
});

router.patch('/:id', async (req, res) => {
    try {
        const { migrationId, id } = (req.params as any);
        const { conversionToBase, isBaseUnit, sellPrice, purchasePrice, version } = req.body;

        if (!version) return res.status(400).json({ error: 'Base version is required' });

        const result = await prisma.$transaction(async (tx) => {
            const current = await tx.productUnit.findUnique({ where: { id }, include: { product: true } });
            if (!current || current.product.migrationId !== migrationId) throw new Error('NOT_FOUND');
            if (current.version !== version) throw new Error('STALE');

            if (isBaseUnit && current.isBaseUnit === false) {
                const existingBase = await tx.productUnit.findFirst({ where: { productId: current.productId, isBaseUnit: true } });
                if (existingBase) throw new Error('MULTIPLE_BASE_UNITS');
            }

            const isNowBase = isBaseUnit !== undefined ? isBaseUnit : current.isBaseUnit;
            const newConv = conversionToBase !== undefined ? conversionToBase : current.conversionToBase;

            if (isNowBase && newConv !== 1) throw new Error('BASE_MUST_BE_1');
            if (newConv <= 0) throw new Error('CONVERSION_MUST_BE_POSITIVE');

            const updateData: any = { version: { increment: 1 } };
            if (conversionToBase !== undefined) updateData.conversionToBase = conversionToBase;
            if (isBaseUnit !== undefined) updateData.isBaseUnit = isBaseUnit;
            if (sellPrice !== undefined) updateData.sellPrice = sellPrice;
            if (purchasePrice !== undefined) updateData.purchasePrice = purchasePrice;

            const updated = await tx.productUnit.update({ where: { id }, data: updateData });

            await tx.migration.update({
                where: { id: migrationId },
                data: { revision: { increment: 1 } }
            });

            return updated;
        });

        res.json(result);
    } catch (error: any) {
        if (error.message === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
        if (error.message === 'STALE') return res.status(409).json({ error: 'Stale update' });
        if (error.message === 'MULTIPLE_BASE_UNITS') return res.status(409).json({ error: 'Base unit already exists' });
        if (error.message === 'BASE_MUST_BE_1') return res.status(400).json({ error: 'Base unit conversion must be 1' });
        if (error.message === 'CONVERSION_MUST_BE_POSITIVE') return res.status(400).json({ error: 'Conversion must be > 0' });
        res.status(500).json({ error: 'Failed to update product unit' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { migrationId, id } = (req.params as any);

        const current = await prisma.productUnit.findUnique({ where: { id }, include: { product: true } });
        if (!current || current.product.migrationId !== migrationId) {
            return res.status(404).json({ error: 'Not found' });
        }

        // Technically we shouldn't delete if stock relies on it, but the schema stores stock breakdown as JSON.
        // We will just let it be deleted or we could enforce business rules. For Phase 1 we allow it.
        
        await prisma.productUnit.delete({ where: { id } });

        await prisma.migration.update({
            where: { id: migrationId },
            data: { revision: { increment: 1 } }
        });

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete product unit' });
    }
});

export default router;
