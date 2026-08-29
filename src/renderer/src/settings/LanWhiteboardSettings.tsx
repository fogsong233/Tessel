import { type ReactElement, useEffect, useState } from 'react';
import { Copy, ExternalLink, Tablet, Wifi } from 'lucide-react';
import type { UiLanguage } from '../../../shared/domain';
import type { LanWhiteboardServerInfo } from '../../../shared/lanWhiteboard';
import { lanWhiteboardText } from '../lanWhiteboardText';

export function LanWhiteboardSettings({ language }: { language: UiLanguage }): ReactElement {
  const text = lanWhiteboardText(language);
  const [info, setInfo] = useState<LanWhiteboardServerInfo>();
  const [copiedUrl, setCopiedUrl] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void window.sidelight.getLanWhiteboardInfo().then((nextInfo) => {
      if (!disposed) {
        setInfo(nextInfo);
      }
    }).catch(() => undefined);
    const unsubscribe = window.sidelight.onLanWhiteboardEvent((event) => {
      if (event.type === 'presence') {
        setInfo((current) => current ? { ...current, clientCount: event.clientCount } : current);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const copyUrl = (url: string): void => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl((current) => current === url ? undefined : current), 1_600);
    });
  };

  return (
    <section className="reader-settings__section reader-settings__lan">
      <div className="reader-settings__section-heading">
        <Tablet size={17} />
        <div><strong>{text.title}</strong><span>{text.description}</span></div>
        <span className={`reader-settings__lan-status${info?.running ? ' is-online' : ''}`}>
          <Wifi size={13} />
          {info?.running ? text.online(info.clientCount) : text.unavailable}
        </span>
      </div>
      <div className="reader-settings__lan-card">
        <div className="reader-settings__lan-steps">
          <span><strong>1</strong>{text.keepRunning}</span>
          <span><strong>2</strong>{text.sameWifi}</span>
          <span><strong>3</strong>{text.openAddress}</span>
        </div>
        <div className="reader-settings__lan-addresses">
          {(info?.urls ?? []).map((url, index) => (
            <div key={url}>
              <span><small>{index === 0 ? text.lanAddress : text.localhost}</small><code>{url}</code></span>
              <button type="button" className={copiedUrl === url ? 'is-copied' : ''} title={text.copyAddress} onClick={() => copyUrl(url)}>
                <Copy size={14} />{copiedUrl === url ? text.copied : text.copy}
              </button>
              <button type="button" title={text.preview} onClick={() => window.open(url, '_blank', 'noopener')}><ExternalLink size={14} /></button>
            </div>
          ))}
          {info && info.urls.length === 0 && <p>{text.noAddress}</p>}
          {!info && <p>{text.loadingAddress}</p>}
        </div>
      </div>
      <p className="reader-settings__lan-note">{text.securityNote}</p>
    </section>
  );
}
