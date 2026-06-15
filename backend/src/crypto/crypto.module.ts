import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/** Global so any module (e.g. channel-connections repo) can inject CryptoService. */
@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
