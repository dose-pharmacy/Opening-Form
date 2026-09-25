import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
  try {
    const { migrationId } = (req.params as any);
    const { page = 1, limit = 50, search } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    let where: any = { migrationId };
    
    if (search && typeof search === 'string') {
        where.OR = [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { brand: { contains: search, mode: 'insensitive' } },
        ];
    }

    const [products, total] = await Promise.all([
        prisma.product.findMany({
            where,
            skip,
            take,
            include: { group: true }
        }),
        prisma.product.count({ where })
    ]);

    res.json({ data: products, total, page: Number(page), limit: take });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { migrationId } = (req.params as any);
    let { sku, name, genericName, brand, groupId, description, isActive } = req.body;
    
    if (!sku || typeof sku !== 'string') {
      return res.status(400).json({ error: 'SKU is required' });
    }
    sku = sku.trim();
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }
    name = name.trim();

    if (groupId) {
        const group = await prisma.productGroup.findUnique({ where: { id: groupId } });
        if (!group) return res.status(400).json({ error: 'Group not found' });
        if (group.migrationId !== migrationId) return res.status(400).json({ error: 'Group belongs to a different migration' });
    }

    const existing = await prisma.product.findUnique({
      where: { migrationId_sku: { migrationId, sku } }
    });

    if (existing) {
      return res.status(409).json({ error: 'SKU already exists in this migration' });
    }

    const product = await prisma.product.create({
      data: { migrationId, sku, name, genericName, brand, groupId, description, isActive: isActive ?? true }
    });
    
    await prisma.migration.update({
      where: { id: migrationId },
      data: { revision: { increment: 1 } }
    });

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.get('/:id', async (req, res) => {
    try {
        const { migrationId, id } = (req.params as any);
        const product = await prisma.product.findUnique({
            where: { id, migrationId },
            include: { group: true, productUnits: { include: { unit: true } } }
        });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve product' });
    }
});

router.patch('/:id', async (req, res) => {
  try {
    const { migrationId, id } = (req.params as any);
    const { sku, name, genericName, brand, groupId, description, isActive, version } = req.body;

    if (!version) {
        return res.status(400).json({ error: 'Base version is required for optimistic concurrency' });
    }

    const current = await prisma.product.findUnique({ where: { id, migrationId } });
    if (!current) {
        return res.status(404).json({ error: 'Product not found' });
    }

    if (current.version !== version) {
        return res.status(409).json({ error: 'Stale update. The record was modified by another user.' });
    }

    if (groupId && groupId !== current.groupId) {
        const group = await prisma.productGroup.findUnique({ where: { id: groupId } });
        if (!group || group.migrationId !== migrationId) {
            return res.status(400).json({ error: 'Invalid group or cross-migration reference' });
        }
    }

    const updateData: any = { version: { increment: 1 } };
    if (sku) updateData.sku = sku.trim();
    if (name) updateData.name = name.trim();
    if (genericName !== undefined) updateData.genericName = genericName;
    if (brand !== undefined) updateData.brand = brand;
    if (groupId !== undefined) updateData.groupId = groupId;
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await prisma.product.update({
      where: { id, migrationId },
      data: updateData
    });

    await prisma.migration.update({
        where: { id: migrationId },
        data: { revision: { increment: 1 } }
    });

    res.json(updated);
  } catch (error: any) {
    if (error.code === 'P2002') {
        return res.status(409).json({ error: 'SKU already exists in this migration' });
    }
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { migrationId, id } = (req.params as any);

    const productUnitsCount = await prisma.productUnit.count({ where: { productId: id } });
    const batchesCount = await prisma.batch.count({ where: { productId: id } });

    if (productUnitsCount > 0 || batchesCount > 0) {
        return res.status(409).json({ error: 'Cannot delete product because it is referenced by units or batches.' });
    }

    await prisma.product.delete({
      where: { id, migrationId }
    });

    await prisma.migration.update({
        where: { id: migrationId },
        data: { revision: { increment: 1 } }
    });

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;
