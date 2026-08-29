import { type ReactElement, useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function LanQrCode({ value }: { value?: string }): ReactElement {
  const [dataUrl, setDataUrl] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setDataUrl(undefined);
    if (!value) {
      return;
    }
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 236,
      color: { dark: '#171914', light: '#ffffff' }
    }).then((url) => {
      if (!disposed) {
        setDataUrl(url);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [value]);

  return (
    <div className="reader-settings__lan-qr" aria-busy={!dataUrl}>
      {dataUrl ? <img src={dataUrl} alt="Tessel LAN whiteboard QR code" /> : <span />}
    </div>
  );
}
