import { useEffect, useState, type ReactNode } from 'react';

export function PrefSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pref-section">
      <div className="pref-section-head">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PrefRow({
  title,
  description,
  htmlFor,
  stack = false,
  aside,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  stack?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const content = (
    <>
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </>
  );
  const text = htmlFor
    ? <label className="pref-text" htmlFor={htmlFor}>{content}</label>
    : <div className="pref-text">{content}</div>;
  return (
    <div className={stack ? 'pref-row stack' : 'pref-row'}>
      {stack && aside ? <div className="pref-row-head">{text}{aside}</div> : text}
      <div className="pref-control">{children}</div>
    </div>
  );
}

export function PrefSwitch({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={disabled ? 'pref-row disabled' : 'pref-row'}>
      <div className="pref-text">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      <input
        className="switch"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function PrefActions({ children }: { children: ReactNode }) {
  return <div className="pref-actions">{children}</div>;
}

export function PrefFlash({ message, error }: { message: string; error: string }) {
  const text = error || message;
  const [shown, setShown] = useState(text);

  useEffect(() => {
    setShown(text);
    if (!text) return;
    const timer = window.setTimeout(() => setShown(''), error ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [text, error]);

  if (!shown) return null;
  return (
    <div className={error ? 'pref-flash bad' : 'pref-flash'} role={error ? 'alert' : 'status'}>
      {shown}
    </div>
  );
}
