import type { AzureConfig, AzureSecret, Connector, ConnectorContext, FtpConfig, FtpSecret, IpfsConfig, IpfsSecret, LocalConfig, LocationKind, S3Config, S3Secret, SftpConfig, SftpSecret } from '../model.js';
import { AzureConnector } from './azure.js';
import { FtpConnector } from './ftp.js';
import { IpfsConnector } from './ipfs.js';
import { LocalConnector } from './local.js';
import { S3Connector } from './s3.js';
import { SftpConnector } from './sftp.js';

/** A connector for a location's kind; config and secret were validated by the service (`CONFIG_SCHEMAS`). */
export async function openConnector(kind: LocationKind, config: Record<string, unknown>, secret: unknown, ctx: ConnectorContext, o: { readOnly?: boolean }): Promise<Connector> {
  switch (kind) {
    case 's3':
      return new S3Connector(config as unknown as S3Config, secret as S3Secret, ctx, o);
    case 'azure':
      return new AzureConnector(config as unknown as AzureConfig, secret as AzureSecret, ctx, o);
    case 'local':
      return new LocalConnector(config as unknown as LocalConfig, ctx, o);
    case 'sftp':
      return new SftpConnector(config as unknown as SftpConfig, secret as SftpSecret, ctx, o);
    case 'ftp':
      return new FtpConnector(config as unknown as FtpConfig, secret as FtpSecret, ctx, o);
    case 'ipfs':
      return new IpfsConnector(config as unknown as IpfsConfig, (secret ?? null) as IpfsSecret, ctx, o);
  }
}
