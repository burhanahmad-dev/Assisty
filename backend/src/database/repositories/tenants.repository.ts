import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface TenantRow {
  id: string;
  name: string;
  createdAt: Date;
}

@Injectable()
export class TenantsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(id: string): Promise<TenantRow | null> {
    const rows = await this.db.sql<TenantRow[]>`
      SELECT id, name, created_at AS "createdAt"
      FROM tenants
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async create(name: string): Promise<TenantRow> {
    const rows = await this.db.sql<TenantRow[]>`
      INSERT INTO tenants (name)
      VALUES (${name})
      RETURNING id, name, created_at AS "createdAt"
    `;
    return rows[0];
  }
}
