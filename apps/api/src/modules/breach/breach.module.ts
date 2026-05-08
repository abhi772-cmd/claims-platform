import { Module } from '@nestjs/common';

import { BreachDetectorService } from './breach-detector.service';
import { BreachIncidentController } from './breach-incident.controller';
import { BreachIncidentService } from './breach-incident.service';

// AuditModule + PrismaService are global; no explicit imports needed.
@Module({
  controllers: [BreachIncidentController],
  providers: [BreachIncidentService, BreachDetectorService],
  exports: [BreachIncidentService, BreachDetectorService],
})
export class BreachModule {}

export { BreachIncidentService } from './breach-incident.service';
export { BreachDetectorService } from './breach-detector.service';
export { renderDpdpNotification, DPDP_NOTIFICATION_WINDOW_MS } from './dpdp-notification-template';
