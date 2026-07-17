import { app } from 'electron';
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { AppUpdateState } from '../shared/domain';

const { autoUpdater } = electronUpdater;
const updateIntervalMs = 6 * 60 * 60 * 1000;

export class AppUpdateService {
  private state: AppUpdateState = {
    status: 'idle',
    currentVersion: app.getVersion()
  };
  private started = false;
  private checking = false;

  constructor(private readonly publish: (state: AppUpdateState) => void) {}

  getState(): AppUpdateState {
    return this.state;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!app.isPackaged) {
      this.setState({ status: 'unsupported', message: 'Updates are available in installed releases.' });
      return;
    }
    if (!['darwin', 'win32'].includes(process.platform)) {
      this.setState({ status: 'unsupported', message: 'Updates are managed by this platform.' });
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = app.getVersion().includes('-');
    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking' }));
    autoUpdater.on('update-available', (info) => this.setState({
      status: 'available',
      availableVersion: info.version,
      releaseNotes: releaseNotes(info)
    }));
    autoUpdater.on('update-not-available', (info) => this.setState({
      status: 'not-available',
      availableVersion: info.version
    }));
    autoUpdater.on('download-progress', (progress) => this.handleDownloadProgress(progress));
    autoUpdater.on('update-downloaded', (info) => this.setState({
      status: 'ready',
      availableVersion: info.version,
      releaseNotes: releaseNotes(info),
      downloadPercent: 100
    }));
    autoUpdater.on('error', (error) => this.setState({
      status: 'error',
      message: error.message || 'Unable to check for updates.'
    }));

    setTimeout(() => void this.check(), 2_000).unref();
    setInterval(() => void this.check(), updateIntervalMs).unref();
  }

  async check(): Promise<AppUpdateState> {
    if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) {
      return this.state;
    }
    if (this.checking || this.state.status === 'downloading' || this.state.status === 'ready') {
      return this.state;
    }

    this.checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to check for updates.'
      });
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  install(): void {
    if (this.state.status !== 'ready') {
      return;
    }
    autoUpdater.quitAndInstall();
  }

  private handleDownloadProgress(progress: ProgressInfo): void {
    this.setState({
      status: 'downloading',
      downloadPercent: Math.max(0, Math.min(100, Math.round(progress.percent * 10) / 10))
    });
  }

  private setState(next: Omit<AppUpdateState, 'currentVersion'>): void {
    this.state = {
      currentVersion: app.getVersion(),
      availableVersion: undefined,
      releaseNotes: undefined,
      downloadPercent: undefined,
      message: undefined,
      ...next
    };
    this.publish(this.state);
  }
}

function releaseNotes(info: UpdateInfo): string | undefined {
  if (typeof info.releaseNotes === 'string') {
    return info.releaseNotes;
  }
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes.map((note) => note.note).filter(Boolean).join('\n\n') || undefined;
  }
  return undefined;
}
