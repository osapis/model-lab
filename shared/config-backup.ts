export const CONFIG_BACKUP_MAX_BYTES = 6 * 1024 * 1024;
export const CONFIG_BACKUP_MIN_PASSWORD_LENGTH = 10;
export const CONFIG_BACKUP_MAX_PASSWORD_LENGTH = 1024;
export interface ConfigBackupEnvelope {
  format: 'model-lab-config'; version: 1; cipher: 'aes-256-gcm';
  kdf: { name: 'scrypt'; N: 32768; r: 8; p: 1; keyLength: 32 };
  salt: string; iv: string; tag: string; ciphertext: string;
}
export interface ConfigBackupCounts { providers: number; models: number; prompts: number; schedules: number }
export interface ConfigBackupSchedulePreview {
  name: string; scheduleType: 'interval' | 'cron'; intervalMinutes: number;
  cronExpression: string; timezone: string;
}
export interface ConfigBackupPreview extends ConfigBackupCounts {
  retentionDays: number; maxRetries: number; requestTimeoutSeconds: number; storageMode: 'memory' | 's3' | 'cloudflare'; createdAt: string;
  scheduleDetails: ConfigBackupSchedulePreview[];
}
export interface ConfigBackupImportResult { imported: ConfigBackupCounts }
export interface ConfigBackupRequest { password: string; backup: ConfigBackupEnvelope }
