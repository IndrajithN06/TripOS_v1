import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { MAX_IMAGE_BYTES } from '../../common/assets';
import { agencyOf, CurrentUser, parse, Principal, Roles } from '../../common/auth';
import { specSchema, TemplateInput, templateInputSchema, TemplatesService } from './templates.service';
import { TemplateSpec, VARIABLES } from './template-spec';

/**
 * Template management. Everyone in an agency can read and preview templates (sales staff need the approved ones);
 * only agency admins can create, change, duplicate, delete, upload media or submit to Meta.
 */
@Roles('AGENCY_ADMIN', 'SALES')
@Controller('agency/whatsapp/templates')
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  list(@CurrentUser() p: Principal, @Query() q: Record<string, string>) {
    return this.svc.list(agencyOf(p), parse(z.object({ status: z.string().max(20).optional(), purpose: z.string().max(30).optional() }), q));
  }

  /** The variables TripOS can fill automatically, with sample values for previews. */
  @Get('variables')
  variables() { return Object.entries(VARIABLES).map(([name, v]) => ({ name, label: v.label, sample: v.sample })); }

  @Post('preview')
  preview(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(z.object({
      spec: specSchema.optional(), templateId: z.string().uuid().optional(), values: z.record(z.string().max(1024)).optional(),
      conversationId: z.string().uuid().optional(), quoteId: z.string().uuid().optional(), versionNumber: z.number().int().min(1).optional(),
    }), body);
    return this.svc.preview(agencyOf(p), { ...b, spec: b.spec as TemplateSpec | undefined });
  }

  @Get(':id') get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(agencyOf(p), id); }

  @Roles('AGENCY_ADMIN')
  @Post()
  create(@CurrentUser() p: Principal, @Body() body: unknown) { return this.svc.create(agencyOf(p), p.userId, parse(templateInputSchema, body) as TemplateInput); }

  @Roles('AGENCY_ADMIN')
  @Patch(':id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) { return this.svc.update(agencyOf(p), p.userId, id, parse(templateInputSchema, body) as TemplateInput); }

  @Roles('AGENCY_ADMIN')
  @Post(':id/duplicate')
  duplicate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.duplicate(agencyOf(p), p.userId, id); }

  @Roles('AGENCY_ADMIN')
  @Delete(':id')
  remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(agencyOf(p), p.userId, id); }

  /** Real provider: submitted to Meta for review (status comes back from Meta). Simulator: marked "submitted". Never "approved" locally. */
  @Roles('AGENCY_ADMIN')
  @Post(':id/submit')
  submit(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.svc.submit(agencyOf(p), p.userId, id); }

  @Roles('AGENCY_ADMIN')
  @Post('media/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  upload(@CurrentUser() p: Principal, @UploadedFile() file: Express.Multer.File) { return this.svc.uploadMedia(agencyOf(p), p.userId, file); }
}
