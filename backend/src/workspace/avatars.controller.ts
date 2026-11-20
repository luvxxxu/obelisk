import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AvatarsService } from './avatars.service';

/**
 * Serves profile photos. Public like most avatar hosts: the id is random and changes with every
 * upload, so the URL works as the key, the invite page can show an organization's photo before
 * sign-in, and the image can be cached forever.
 */
@Controller('api/avatars')
export class AvatarsController {
  constructor(private readonly avatars: AvatarsService) {}

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const row = await this.avatars.get(id);
    if (!row) throw new NotFoundException('사진을 찾을 수 없습니다');
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Length', String(row.data.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Bytes were sniffed on upload; still never let a browser run them as anything but an image.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(row.data);
  }
}
