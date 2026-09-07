import { type ReactElement, useEffect, useState } from 'react';
import { Copy, ExternalLink, Tablet, Wifi } from 'lucide-react';
import type { UiLanguage } from '../../../shared/domain';
import type { LanWhiteboardServerInfo } from '../../../shared/lanWhiteboard';
import { lanWhiteboardText } from '../i18n/lanWhiteboardText';
import { LanQrCode } from './LanQrCode';

export function LanWhiteboardSettings({ language }: { language: UiLanguage }): ReactElement {
  const text = lanWhiteboardText(language);
  const [info, setInfo] = useState<LanWhiteboardServerInfo>();
  const [copiedUrl, setCopiedUrl] = useState<string>();
  const addresses = info?.addresses ?? [];
  const recommended = addresses.find((address) => address.recommended)
    ?? addresses.find((address) => !address.loopback)
    ?? addresses[0];
  const otherAddresses = addresses.filter((address) => address.url !== recommended?.url);

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
        <div className="reader-settings__lan-connect">
          <LanQrCode value={recommended?.url} />
          <div className="reader-settings__lan-connect-copy">
            <span className="reader-settings__lan-eyebrow">{text.lanAddress}</span>
            <strong>{text.scanTitle}</strong>
            <p>{text.scanDescription}</p>
            {recommended ? (
              <div className="reader-settings__lan-primary-address">
                <code title={recommended.url}>{recommended.url}</code>
                <button type="button" className={copiedUrl === recommended.url ? 'is-copied' : ''} title={text.copyAddress} onClick={() => copyUrl(recommended.url)}>
                  <Copy size={14} />{copiedUrl === recommended.url ? text.copied : text.copy}
                </button>
                <button type="button" title={text.preview} onClick={() => window.open(recommended.url, '_blank', 'noopener')}><ExternalLink size={14} /></button>
              </div>
            ) : <p>{info ? text.noAddress : text.loadingAddress}</p>}
          </div>
        </div>
        <div className="reader-settings__lan-steps">
          <span><strong>1</strong>{text.keepRunning}</span>
          <span><strong>2</strong>{text.sameWifi}</span>
          <span><strong>3</strong>{text.openAddress}</span>
        </div>
        {otherAddresses.length > 0 && (
          <details className="reader-settings__lan-addresses">
            <summary>{text.otherAddresses}<span>{otherAddresses.length}</span></summary>
            <div>
              {otherAddresses.map((address) => (
                <div key={address.url}>
                  <span><small>{address.loopback ? text.localhost : address.interfaceName}</small><code>{address.url}</code></span>
                  <button type="button" className={copiedUrl === address.url ? 'is-copied' : ''} title={text.copyAddress} onClick={() => copyUrl(address.url)}>
                    <Copy size={14} />{copiedUrl === address.url ? text.copied : text.copy}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      <p className="reader-settings__lan-note">{text.securityNote}</p>
    </section>
  );
}
