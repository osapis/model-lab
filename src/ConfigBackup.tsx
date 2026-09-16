import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, Download, FileJson, Info, KeyRound, LoaderCircle, LockKeyhole, Upload, XCircle } from 'lucide-react';
import type { AdminData } from '../shared/types';
import { normalizeRequestTimeoutSeconds } from '../shared/timeouts';
import {
  CONFIG_BACKUP_MAX_BYTES, CONFIG_BACKUP_MAX_PASSWORD_LENGTH, CONFIG_BACKUP_MIN_PASSWORD_LENGTH,
  type ConfigBackupEnvelope, type ConfigBackupImportResult, type ConfigBackupPreview,
} from '../shared/config-backup';
import { api, json } from './api';
import './config-backup.css';

type Phase = 'idle' | 'reading' | 'exporting' | 'previewing' | 'importing';
type Props = {
  data: AdminData;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => Promise<void>;
};
const fileLimitLabel = `${CONFIG_BACKUP_MAX_BYTES / 1024 / 1024} MiB`;
const passwordValid = (password: string) => password.length >= CONFIG_BACKUP_MIN_PASSWORD_LENGTH && password.length <= CONFIG_BACKUP_MAX_PASSWORD_LENGTH;
const storageLabel = (mode: AdminData['storage']['mode']) => mode === 'cloudflare' ? 'Cloudflare 原生云端' : mode === 's3' ? 'Cloudflare R2 / S3' : '服务器内存';
const failureMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const countLabels = { providers: 'API 接口', models: '参测模型', prompts: '提示词', schedules: '定时计划' } as const;

// Keep downloaded files restricted to the agreed encrypted envelope fields.
function encryptedEnvelope(value: unknown): ConfigBackupEnvelope {
  if (!value || typeof value !== 'object') throw new Error('文件不是受支持的加密配置备份。');
  const envelope = value as Partial<ConfigBackupEnvelope>;
  const kdf = envelope.kdf;
  if (envelope.format !== 'model-lab-config' || envelope.version !== 1 || envelope.cipher !== 'aes-256-gcm'
    || !kdf || kdf.name !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1 || kdf.keyLength !== 32
    || typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('文件不是受支持的加密配置备份，请选择本站导出的 JSON 文件。');
  }
  return {
    format: 'model-lab-config', version: 1, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32 },
    salt: envelope.salt, iv: envelope.iv, tag: envelope.tag, ciphertext: envelope.ciphertext,
  };
}

export default function ConfigBackup({ data, disabled, onBusyChange, onChanged }: Props) {
  const [exportPassword, setExportPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [backup, setBackup] = useState<ConfigBackupEnvelope | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ConfigBackupPreview | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const phaseRef = useRef<Phase>('idle');
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const epoch = useRef(0);
  const urls = useRef(new Set<string>());
  const locked = disabled || phase !== 'idle';
  const passwordsMatch = exportPassword === confirmPassword;
  const insecureTransport = window.location.protocol !== 'https:'
    && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);

  useEffect(() => () => {
    epoch.current++;
    controller.current?.abort();
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    if (fileInput.current) fileInput.current.value = '';
    onBusyChange(false);
  }, [onBusyChange]);

  function changePhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
    onBusyChange(next !== 'idle');
  }

  function clearSensitiveInputs() {
    setExportPassword(''); setConfirmPassword(''); setImportPassword('');
    setBackup(null); setFileName(''); setPreview(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function resetPreview() { setPreview(null); setError(''); setNotice(''); }

  function begin(next: Phase) {
    const version = ++epoch.current;
    const request = new AbortController();
    controller.current = request;
    setError(''); setNotice(''); changePhase(next);
    return { version, request };
  }

  function finish(version: number) {
    if (version !== epoch.current) return;
    controller.current = null;
    changePhase('idle');
  }

  async function exportConfig(event: FormEvent) {
    event.preventDefault();
    if (disabled || phaseRef.current !== 'idle' || !passwordValid(exportPassword) || !passwordsMatch) return;
    const { version, request } = begin('exporting');
    try {
      const result = await api<ConfigBackupEnvelope>('/api/admin/config/export', { ...json('POST', { password: exportPassword }), signal: request.signal });
      if (version !== epoch.current) return;
      const blob = new Blob([JSON.stringify(encryptedEnvelope(result), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = `model-lab-config-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
      clearSensitiveInputs();
      setNotice('加密配置备份已生成并开始下载。请保管备份密码，导入时需要使用相同密码。');
    } catch (error) {
      if (version === epoch.current && !request.signal.aborted) setError(failureMessage(error));
    } finally { finish(version); }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    if (disabled || phaseRef.current !== 'idle') return;
    const file = event.target.files?.[0];
    setBackup(null); setFileName(''); setImportPassword(''); resetPreview();
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) { setError('请选择 .json 格式的加密配置备份。'); event.target.value = ''; return; }
    if (!file.size || file.size > CONFIG_BACKUP_MAX_BYTES) { setError(`备份文件不能为空，且不能超过 ${fileLimitLabel}。`); event.target.value = ''; return; }
    const { version } = begin('reading');
    try {
      const content = await file.text();
      if (version !== epoch.current) return;
      let parsed: unknown;
      try { parsed = JSON.parse(content); }
      catch { throw new Error('备份文件不是有效的 JSON，请重新选择完整的导出文件。'); }
      setBackup(encryptedEnvelope(parsed)); setFileName(file.name);
    } catch (error) {
      if (version === epoch.current) { setError(failureMessage(error)); if (fileInput.current) fileInput.current.value = ''; }
    } finally { finish(version); }
  }

  async function previewImport(event: FormEvent) {
    event.preventDefault();
    if (disabled || phaseRef.current !== 'idle' || !backup || !passwordValid(importPassword)) return;
    const { version, request } = begin('previewing');
    setPreview(null);
    try {
      const result = await api<{ preview: ConfigBackupPreview }>('/api/admin/config/preview', { ...json('POST', { password: importPassword, backup }), signal: request.signal });
      if (version === epoch.current) setPreview(result.preview);
    } catch (error) {
      if (version === epoch.current && !request.signal.aborted) setError(failureMessage(error));
    } finally { finish(version); }
  }

  async function importConfig() {
    if (disabled || phaseRef.current !== 'idle' || !backup || !preview || !passwordValid(importPassword)) return;
    const { version, request } = begin('importing');
    let imported = false;
    try {
      const result = await api<ConfigBackupImportResult>('/api/admin/config/import', { ...json('POST', { password: importPassword, backup }), signal: request.signal });
      if (version !== epoch.current) return;
      imported = true;
      clearSensitiveInputs();
      const counts = Object.entries(countLabels).map(([key, label]) => `${result.imported[key as keyof typeof countLabels]} 个${label}`).join('、');
      setNotice(`配置已导入：${counts}。新增定时计划保持暂停，请在定时任务中确认后启用。`);
      await onChanged();
    } catch (error) {
      if (version === epoch.current && !request.signal.aborted) setError(imported ? '配置已成功导入，但页面数据刷新失败。请点击顶部“刷新数据”，无需重复导入。' : failureMessage(error));
    } finally { finish(version); }
  }

  const createdAt = preview ? new Date(preview.createdAt) : null;
  return <div className="admin-stack">
    <div className="admin-backup-intro"><span><LockKeyhole size={24} /></span><div><h2>把实验室配置带到另一台服务器。</h2><p>接口与 API Key、模型、提示词、定时计划（含 Cron 表达式与时区）、历史保留、失败重试、请求超时和存储配置统一加密备份。历史记录、作品和管理口令不包含在备份中；Cloudflare 原生存储随目标部署绑定。</p></div></div>
    {insecureTransport && <p className="admin-backup-impact" role="status"><Info size={16} /><span>当前使用 HTTP，登录口令、API Key 和备份密码在传输中未加密。请使用 HTTPS 后再进行敏感操作。</span></p>}
    {error && <div className="admin-alert admin-alert-error" role="alert"><XCircle size={17} /><span>{error}</span></div>}
    {notice && <div className="admin-alert admin-alert-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span></div>}
    <div className="admin-backup-layout">
      <section className="admin-panel admin-backup-panel"><div className="admin-section-heading"><div><h2><Download size={17} />导出配置</h2><p>设置备份密码，下载加密 JSON 文件。</p></div></div>
        <div className="admin-backup-counts">{Object.entries(countLabels).map(([key, label]) => <div key={key}><strong>{data[key as keyof typeof countLabels].length}</strong><span>{label}</span></div>)}</div>
        <form onSubmit={exportConfig} className="admin-backup-form">
          <label className="admin-field">备份密码<input type="password" value={exportPassword} onChange={(event) => { setExportPassword(event.target.value); setNotice(''); }} autoComplete="new-password" minLength={CONFIG_BACKUP_MIN_PASSWORD_LENGTH} maxLength={CONFIG_BACKUP_MAX_PASSWORD_LENGTH} placeholder={`至少 ${CONFIG_BACKUP_MIN_PASSWORD_LENGTH} 个字符`} disabled={locked} required /><small>用于加密配置文件。请保存此密码，空格也会作为密码的一部分。</small></label>
          <label className="admin-field">确认备份密码<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={CONFIG_BACKUP_MIN_PASSWORD_LENGTH} maxLength={CONFIG_BACKUP_MAX_PASSWORD_LENGTH} placeholder="再次输入相同密码" disabled={locked} required />{confirmPassword && !passwordsMatch && <small className="admin-backup-field-error">两次输入的密码不一致。</small>}</label>
          <button type="submit" className="admin-button admin-button-primary" disabled={locked || !passwordValid(exportPassword) || !passwordsMatch}>{phase === 'exporting' ? <LoaderCircle size={16} className="admin-spin" /> : <Download size={16} />}{phase === 'exporting' ? '正在加密配置…' : '加密并下载备份'}</button>
        </form>
        <p className="admin-backup-note"><KeyRound size={15} />下载文件仅包含加密数据；导出完成后，本页会清空已输入的密码和文件。</p>
      </section>
      <section className="admin-panel admin-backup-panel"><div className="admin-section-heading"><div><h2><Upload size={17} />导入配置</h2><p>选择备份文件，解密预览后再确认导入。</p></div></div>
        <form onSubmit={previewImport} className="admin-backup-form">
          <label className="admin-field">加密备份文件<input ref={fileInput} type="file" accept=".json,application/json" onChange={(event) => { void chooseFile(event); }} disabled={locked} /><small>仅支持本站导出的 JSON 备份，文件最大 {fileLimitLabel}。</small></label>
          {fileName && <p className="admin-backup-file"><FileJson size={15} /><span>{fileName}</span></p>}
          <label className="admin-field">解密密码<input type="password" value={importPassword} onChange={(event) => { setImportPassword(event.target.value); resetPreview(); }} autoComplete="off" minLength={CONFIG_BACKUP_MIN_PASSWORD_LENGTH} maxLength={CONFIG_BACKUP_MAX_PASSWORD_LENGTH} placeholder="输入导出此备份时设置的密码" disabled={locked} required /></label>
          <button type="submit" className="admin-button" disabled={locked || !backup || !passwordValid(importPassword)}>{phase === 'previewing' || phase === 'reading' ? <LoaderCircle size={16} className="admin-spin" /> : <FileJson size={16} />}{phase === 'reading' ? '正在读取文件…' : phase === 'previewing' ? '正在解密预览…' : '解密并预览配置'}</button>
        </form>
        {preview && <div className="admin-backup-preview"><div className="admin-backup-preview-heading"><h3>确认导入内容</h3><span>备份时间：{createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleString('zh-CN') : '未知'}</span></div>
          <div className="admin-backup-counts">{Object.entries(countLabels).map(([key, label]) => <div key={key}><strong>+{preview[key as keyof typeof countLabels]}</strong><span>{label}</span></div>)}</div>
          <p className="admin-backup-explanation">接口、模型、提示词和计划将作为新配置添加，现有内容保留。所有导入的定时计划保持暂停。</p>
          {!!preview.scheduleDetails?.length && <details><summary>查看计划时间（{preview.scheduleDetails.length} 项）</summary><dl className="admin-backup-settings" style={{ overflowWrap: 'anywhere' }}>{preview.scheduleDetails.map((schedule, index) => <div key={index}><dt>{schedule.name}</dt><dd>{schedule.scheduleType === 'cron' ? <><strong>Cron</strong><code>{schedule.cronExpression}</code><span>{schedule.timezone}</span></> : <strong>每隔 {schedule.intervalMinutes} 分钟</strong>}</dd></div>)}</dl></details>}
          <dl className="admin-backup-settings"><div><dt>全局历史保留</dt><dd><span>{data.settings.retentionDays} 天</span><ArrowRight size={13} /><strong>{preview.retentionDays} 天</strong></dd></div><div><dt>失败重试次数</dt><dd><span>{data.settings.maxRetries ?? 5} 次</span><ArrowRight size={13} /><strong>{preview.maxRetries} 次</strong></dd></div><div><dt>单次请求超时</dt><dd><span>{normalizeRequestTimeoutSeconds(data.settings.requestTimeoutSeconds)} 秒</span><ArrowRight size={13} /><strong>{preview.requestTimeoutSeconds} 秒</strong></dd></div><div><dt>结果存储方式</dt><dd><span>{storageLabel(data.storage.mode)}</span><ArrowRight size={13} /><strong>{storageLabel(data.storage.mode === 'cloudflare' || preview.storageMode === 'cloudflare' ? data.storage.mode : preview.storageMode)}</strong></dd></div></dl>
          <p className="admin-backup-explanation">首次请求不计入重试次数，5 次表示失败后最多额外请求 5 次；旧版备份未包含此设置时恢复为 5 次，未包含请求超时时恢复为 600 秒。</p>
          <p className="admin-backup-impact"><Info size={15} /><span>{data.storage.mode === 'cloudflare' || preview.storageMode === 'cloudflare' ? '全局保留时间、失败重试次数与请求超时将应用备份设置；当前部署的存储方式保持不变，云端作品不会随配置导入。' : '全局保留时间、失败重试次数、请求超时与存储配置（含凭据）将应用备份中的设置。'}{preview.retentionDays < data.settings.retentionDays ? '保留期限缩短后，过期历史和作品会按新设置自动清理。' : '已有历史和作品仍按保留设置管理。'}</span></p>
          <div className="admin-backup-confirm-actions"><button type="button" className="admin-button admin-button-small" disabled={locked} onClick={() => { clearSensitiveInputs(); setError(''); setNotice(''); }}>取消并清空</button><button type="button" className="admin-button admin-button-primary admin-button-small" disabled={locked} onClick={() => { void importConfig(); }}>{phase === 'importing' ? <LoaderCircle size={15} className="admin-spin" /> : <Upload size={15} />}{phase === 'importing' ? '正在导入配置…' : '确认导入配置'}</button></div>
        </div>}
      </section>
    </div>
    <p className="admin-backup-privacy"><LockKeyhole size={14} />密码和待导入文件仅保留在当前页面内存中，完成迁移或离开此页时清空。</p>
  </div>;
}
