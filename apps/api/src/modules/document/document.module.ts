import { Module } from '@nestjs/common';

import { DocumentLifecycleWorker } from './document-lifecycle.worker';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { CaseModule } from '../case';

@Module({
  imports: [CaseModule],
  controllers: [DocumentController],
  providers: [DocumentService, DocumentLifecycleWorker],
  exports: [DocumentService, DocumentLifecycleWorker],
})
export class DocumentModule {}
