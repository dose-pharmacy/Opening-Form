import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

// GET /migrations/:migrationId/groups
router.get('/', async (req, res) => {
  try {
    const { migrationId } = (req.params as any);
    const groups = await prisma.productGroup.findMany({
      where: { migrationId }
    });
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// POST /migrations/:migrationId/groups
router.post('/', async (req, res) => {
  try {
    const { migrationId } = (req.params as any);
    let { name } = req.body;
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    name = name.trim();
    if (name.length === 0) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    // Check uniqueness
    const existing = await prisma.productGroup.findUnique({
      where: { migrationId_name: { migrationId, name } }
    });

    if (existing) {
      return res.status(409).json({ error: 'Group name already exists in this migration' });
    }

    const group = await prisma.productGroup.create({
      data: { migrationId, name }
    });
    
    // Increment migration revision
    await prisma.migration.update({
      where: { id: migrationId },
      data: { revision: { increment: 1 } }
    });

    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// PATCH /migrations/:migrationId/groups/:id
router.patch('/:id', async (req, res) => {
  try {
    const { migrationId, id } = (req.params as any);
    const { name, version } = req.body;

    if (!version) {
        return res.status(400).json({ error: 'Base version is required for optimistic concurrency' });
    }

    const current = await prisma.productGroup.findUnique({ where: { id } });
    if (!current) {
        return res.status(404).json({ error: 'Group not found' });
    }

    if (current.version !== version) {
        return res.status(409).json({ error: 'Stale update. The record was modified by another user.', currentVersion: current.version });
    }

    const updateData: any = { version: { increment: 1 } };
    if (name) {
        const trimmed = name.trim();
        if (trimmed.length > 0) updateData.name = trimmed;
    }

    const updated = await prisma.productGroup.update({
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
        return res.status(409).json({ error: 'Group name already exists in this migration' });
    }
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// DELETE /migrations/:migrationId/groups/:id
router.delete('/:id', async (req, res) => {
  try {
    const { migrationId, id } = (req.params as any);

    // Check if group is referenced by any product
    const productCount = await prisma.product.count({
        where: { groupId: id }
    });

    if (productCount > 0) {
        return res.status(409).json({ error: 'Cannot delete group because it is referenced by products.' });
    }

    await prisma.productGroup.delete({
      where: { id, migrationId }
    });

    await prisma.migration.update({
        where: { id: migrationId },
        data: { revision: { increment: 1 } }
    });

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

export default router;
