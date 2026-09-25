import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

router.post('/', async (req, res) => {
  const { migrationId } = req.params;
  const { operations } = req.body;

  if (!Array.isArray(operations)) {
    return res.status(400).json({ error: 'Operations must be an array' });
  }

  const results = [];
  let successfulOperations = 0;

  for (const op of operations) {
    const { operationId, entityType, entityId, operationType, baseVersion, payload } = op;

    try {
      // 1. Idempotency Check
      const existingOp = await prisma.processedOperation.findUnique({
        where: { operationId }
      });

      if (existingOp) {
        results.push(existingOp.result);
        continue;
      }

      // 2. Process Operation
      let result;
      await prisma.$transaction(async (tx) => {
        // Implement logic for each operation type and entity
        // To handle dynamic updates based on version for Optimistic Concurrency
        
        switch (entityType) {
          case 'PRODUCT':
            if (operationType === 'CREATE') {
              const created = await tx.product.create({
                data: {
                  ...payload,
                  id: entityId,
                  migrationId,
                  version: 1
                }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
            } else if (operationType === 'UPDATE') {
              const current = await tx.product.findUnique({ where: { id: entityId } });
              if (!current) throw new Error('NOT_FOUND');
              if (current.version !== baseVersion) {
                result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                return; // Return from transaction, but don't throw to commit the ProcessedOperation
              }
              const updated = await tx.product.update({
                where: { id: entityId },
                data: { ...payload, version: current.version + 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
            } else if (operationType === 'DELETE') {
              // Delete logic
              await tx.product.delete({ where: { id: entityId } });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: 0 };
            }
            break;
            
          case 'GROUP':
            if (operationType === 'CREATE') {
              const created = await tx.productGroup.create({
                data: { ...payload, id: entityId, migrationId, version: 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
            } else if (operationType === 'UPDATE') {
              const current = await tx.productGroup.findUnique({ where: { id: entityId } });
              if (!current) throw new Error('NOT_FOUND');
              if (current.version !== baseVersion) {
                result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                return;
              }
              const updated = await tx.productGroup.update({
                where: { id: entityId },
                data: { ...payload, version: current.version + 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
            }
            break;

          case 'LOCATION':
             if (operationType === 'CREATE') {
               const created = await tx.location.create({
                 data: { ...payload, id: entityId, migrationId, version: 1 }
               });
               result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
             } else if (operationType === 'UPDATE') {
               const current = await tx.location.findUnique({ where: { id: entityId } });
               if (!current) throw new Error('NOT_FOUND');
               if (current.version !== baseVersion) {
                 result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                 return;
               }
               const updated = await tx.location.update({
                 where: { id: entityId },
                 data: { ...payload, version: current.version + 1 }
               });
               result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
             }
             break;

          case 'UNIT':
            if (operationType === 'CREATE') {
              const created = await tx.unit.create({
                data: { ...payload, id: entityId, migrationId, version: 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
            } else if (operationType === 'UPDATE') {
              const current = await tx.unit.findUnique({ where: { id: entityId } });
              if (!current) throw new Error('NOT_FOUND');
              if (current.version !== baseVersion) {
                result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                return;
              }
              const updated = await tx.unit.update({
                where: { id: entityId },
                data: { ...payload, version: current.version + 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
            }
            break;

          case 'PRODUCT_UNIT':
            if (operationType === 'CREATE') {
              const created = await tx.productUnit.create({
                data: { ...payload, id: entityId, version: 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
            } else if (operationType === 'UPDATE') {
              const current = await tx.productUnit.findUnique({ where: { id: entityId } });
              if (!current) throw new Error('NOT_FOUND');
              if (current.version !== baseVersion) {
                result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                return;
              }
              const updated = await tx.productUnit.update({
                where: { id: entityId },
                data: { ...payload, version: current.version + 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
            }
            break;

          case 'BATCH':
            if (operationType === 'CREATE') {
              const created = await tx.batch.create({
                data: { ...payload, id: entityId, migrationId, version: 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
            } else if (operationType === 'UPDATE') {
              const current = await tx.batch.findUnique({ where: { id: entityId } });
              if (!current) throw new Error('NOT_FOUND');
              if (current.version !== baseVersion) {
                result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                return;
              }
              const updated = await tx.batch.update({
                where: { id: entityId },
                data: { ...payload, version: current.version + 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
            }
            break;

          case 'OPENING_STOCK':
            if (operationType === 'CREATE') {
              const created = await tx.openingStock.create({
                data: { ...payload, id: entityId, migrationId, version: 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: created.version };
            } else if (operationType === 'UPDATE') {
              const current = await tx.openingStock.findUnique({ where: { id: entityId } });
              if (!current) throw new Error('NOT_FOUND');
              if (current.version !== baseVersion) {
                result = { operationId, status: 'CONFLICT', entityType, entityId, currentVersion: current.version, serverData: current };
                return;
              }
              const updated = await tx.openingStock.update({
                where: { id: entityId },
                data: { ...payload, version: current.version + 1 }
              });
              result = { operationId, status: 'SYNCED', entityType, operationType, entityId, version: updated.version };
            }
            break;

          default:
            throw new Error('UNKNOWN_ENTITY_TYPE');
        }

        if (result && result.status !== 'CONFLICT') {
            await tx.processedOperation.create({
                data: {
                    operationId,
                    migrationId,
                    result
                }
            });
            successfulOperations++;
        }
      });
      
      results.push(result || { operationId, status: 'ERROR', message: 'Unhandled operation' });

    } catch (error: any) {
      if (error.code === 'P2002') {
         // Unique constraint violation (likely a conflict during create or something)
         results.push({ operationId, status: 'CONFLICT', error: 'UNIQUE_CONSTRAINT_VIOLATION' });
      } else {
         results.push({ operationId, status: 'ERROR', error: error.message });
      }
    }
  }

  // Update migration revision if any operation was successful
  if (successfulOperations > 0) {
      await prisma.migration.update({
          where: { id: migrationId },
          data: { revision: { increment: 1 } }
      });
  }

  res.json({ results });
});

export default router;
