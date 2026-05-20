import { Module } from '@nestjs/common';

import { RoomCategoryController } from './room-category.controller';
import { RoomCategoryService } from './room-category.service';

@Module({
  controllers: [RoomCategoryController],
  providers: [RoomCategoryService],
  exports: [RoomCategoryService],
})
export class RoomCategoryModule {}
