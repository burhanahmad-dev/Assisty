import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TenantsRepository } from './repositories/tenants.repository';
import { ChannelConnectionsRepository } from './repositories/channel-connections.repository';
import { ConversationsRepository } from './repositories/conversations.repository';
import { MessagesRepository } from './repositories/messages.repository';
import { KbRepository } from './repositories/kb.repository';
import { UsageRepository } from './repositories/usage.repository';
import { WebhookEventsRepository } from './repositories/webhook-events.repository';

/**
 * Global database layer. Provides the shared postgres.js client wrapper
 * (DatabaseService) plus every repository, and exports them all so any feature
 * module can inject them without re-importing this module.
 *
 * Tenant scoping is enforced at the application level inside repositories
 * (every tenant-scoped query filters by tenant_id). Postgres RLS is a planned
 * later hardening step.
 */
const REPOSITORIES = [
  TenantsRepository,
  ChannelConnectionsRepository,
  ConversationsRepository,
  MessagesRepository,
  KbRepository,
  UsageRepository,
  WebhookEventsRepository,
];

@Global()
@Module({
  providers: [DatabaseService, ...REPOSITORIES],
  exports: [DatabaseService, ...REPOSITORIES],
})
export class DatabaseModule {}
