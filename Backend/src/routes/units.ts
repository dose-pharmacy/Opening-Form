import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
  try {
    const { migrationId } = req.params;
    const units = await prisma.unit.findMany({
      where: { migrationId }
    });
    res.json(units);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch units' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { migrationId } = req.params;
    let { name, symbol, description } = req.body;
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    name = name.trim();
    if (name.length === 0) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    const existing = await prisma.unit.findUnique({
      where: { migrationId_name: { migrationId, name } }
    });

    if (existing) {
      return res.status(409).json({ error: 'Unit name already exists in this migration' });
    }

    const unit = await prisma.unit.create({
      data: { migrationId, name, symbol, description }
    });
    
    await prisma.migration.update({
      where: { id: migrationId },
      data: { revision: { increment: 1 } }
    });

    res.status(201).json(unit);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create unit' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { migrationId, id } = req.params;
    const { name, symbol, description, version } = req.body;

    if (!version) {
        return res.status(400).json({ error: 'Base version is required for optimistic concurrency' });
    }

    const current = await prisma.unit.findUnique({ where: { id } });
    if (!current) {
        return res.status(404).json({ error: 'Unit not found' });
    }

    if (current.version !== version) {
        return res.status(409).json({ error: 'Stale update. The record was modified by another user.' });
    }

    const updateData: any = { version: { increment: 1 } };
    if (name) updateData.name = name.trim();
    if (symbol !== undefined) updateData.symbol = symbol;
    if (description !== undefined) updateData.description = description;

    const updated = await prisma.unit.update({
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
        return res.status(409).json({ error: 'Unit name already exists in this migration' });
    }
    res.status(500).json({ error: 'Failed to update unit' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { migrationId, id } = req.params;

    const puCount = await prisma.productUnit.count({
        where: { unitId: id }
    });

    if (puCount > 0) {
        return res.status(409).json({ error: 'Cannot delete unit because it is used by products.' });
    }

    await prisma.unit.delete({
      where: { id, migrationId }
    });

    await prisma.migration.update({
        where: { id: migrationId },
        data: { revision: { increment: 1 } }
    });

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete unit' });
  }
});

export default router;
