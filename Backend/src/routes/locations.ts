import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

// GET /migrations/:migrationId/locations
router.get('/', async (req, res) => {
  try {
    const { migrationId } = req.params;
    const locations = await prisma.location.findMany({
      where: { migrationId }
    });
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

// POST /migrations/:migrationId/locations
router.post('/', async (req, res) => {
  try {
    const { migrationId } = req.params;
    let { name, description } = req.body;
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    name = name.trim();
    if (name.length === 0) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    const existing = await prisma.location.findUnique({
      where: { migrationId_name: { migrationId, name } }
    });

    if (existing) {
      return res.status(409).json({ error: 'Location name already exists in this migration' });
    }

    const location = await prisma.location.create({
      data: { migrationId, name, description }
    });
    
    await prisma.migration.update({
      where: { id: migrationId },
      data: { revision: { increment: 1 } }
    });

    res.status(201).json(location);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create location' });
  }
});

// PATCH /migrations/:migrationId/locations/:id
router.patch('/:id', async (req, res) => {
  try {
    const { migrationId, id } = req.params;
    const { name, description, version } = req.body;

    if (!version) {
        return res.status(400).json({ error: 'Base version is required for optimistic concurrency' });
    }

    const current = await prisma.location.findUnique({ where: { id } });
    if (!current) {
        return res.status(404).json({ error: 'Location not found' });
    }

    if (current.version !== version) {
        return res.status(409).json({ error: 'Stale update. The record was modified by another user.' });
    }

    const updateData: any = { version: { increment: 1 } };
    if (name) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description;

    const updated = await prisma.location.update({
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
        return res.status(409).json({ error: 'Location name already exists in this migration' });
    }
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// DELETE /migrations/:migrationId/locations/:id
router.delete('/:id', async (req, res) => {
  try {
    const { migrationId, id } = req.params;

    const stockCount = await prisma.openingStock.count({
        where: { locationId: id }
    });

    if (stockCount > 0) {
        return res.status(409).json({ error: 'Cannot delete location because it is referenced by opening stock records.' });
    }

    await prisma.location.delete({
      where: { id, migrationId }
    });

    await prisma.migration.update({
        where: { id: migrationId },
        data: { revision: { increment: 1 } }
    });

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

export default router;
