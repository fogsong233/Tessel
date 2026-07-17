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
  private operation: 'check' | 'download' | undefined;

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
    if (process.platform === 'darwin') {
      this.setState({
        status: 'unsupported',
        message: 'This unsigned macOS build supports manual updates. Download the latest release to update.'
      });
      return;
    }
    if (process.platform !== 'win32') {
      this.setState({ status: 'unsupported', message: 'Updates are managed by this platform.' });
      return;
    }

    // Checking is automatic; downloading and installing require an explicit user choice.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
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
    autoUpdater.on('error', (error) => this.handleError(error));

    setTimeout(() => void this.check(), 2_000).unref();
    setInterval(() => void this.check(), updateIntervalMs).unref();
  }

  async check(): Promise<AppUpdateState> {
    if (!app.isPackaged || process.platform !== 'win32') {
      return this.state;
    }
    if (this.checking || this.state.status === 'downloading' || this.state.status === 'ready') {
      return this.state;
    }

    this.checking = true;
    this.operation = 'check';
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.checking = false;
      this.operation = undefined;
    }
    return this.state;
  }

  install(): void {
    if (this.state.status !== 'ready') {
      return;
    }
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : String(error || 'Unknown error');
      this.setState({
        status: 'ready',
        availableVersion: this.state.availableVersion,
        releaseNotes: this.state.releaseNotes,
        downloadPercent: 100,
        message: `Install could not start: ${detail}`
      });
    }
  }

  async download(): Promise<AppUpdateState> {
    if (this.state.status !== 'available') {
      return this.state;
    }

    try {
      this.operation = 'download';
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.operation = undefined;
    }
    return this.state;
  }

  dismiss(): AppUpdateState {
    if (this.state.status === 'available' || this.state.status === 'error') {
      this.setState({ status: 'idle' });
    }
    return this.state;
  }

  private handleDownloadProgress(progress: ProgressInfo): void {
    this.setState({
      status: 'downloading',
      availableVersion: this.state.availableVersion,
      releaseNotes: this.state.releaseNotes,
      downloadPercent: Math.max(0, Math.min(100, Math.round(progress.percent * 10) / 10))
    });
  }

  private handleError(error: unknown): void {
    const detail = error instanceof Error && error.message ? error.message : String(error || 'Unknown error');
    if (this.operation === 'download' && this.state.availableVersion) {
      this.setState({
        status: 'available',
        availableVersion: this.state.availableVersion,
        releaseNotes: this.state.releaseNotes,
        message: `Download failed: ${detail}`
      });
      return;
    }

    this.setState({
      status: 'error',
      message: this.operation === 'download' ? `Download failed: ${detail}` : `Unable to check for updates: ${detail}`
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
  const notes = typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((note) => note.note).filter(Boolean).join('\n\n')
      : '';
  const normalized = notes
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*li\s*>/gi, '\n- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || undefined;
}
