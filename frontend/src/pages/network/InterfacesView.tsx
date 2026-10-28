import { kindLabels, stateTone, type Iface, type NetSnapshot, type TestRequest } from './model';
import { Rates, StateBadge } from './parts';

const order: Record<string, number> = { ethernet: 0, vlan: 1, wireguard: 2, openvpn: 2, l2tp: 2, bridge: 3, other: 4 };

export function InterfacesView({ data, onTest }: { data: NetSnapshot; onTest: (request: TestRequest) => void }) {
  const list = [...data.interfaces].sort((a, b) => Number(b.main) - Number(a.main) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  return (
    <div className="net-cards">
      {list.map((item) => <InterfaceCard key={item.name} item={item} onTest={onTest} />)}
    </div>
  );
}

function InterfaceCard({ item, onTest }: { item: Iface; onTest: (request: TestRequest) => void }) {
  const errors = item.rx.errors + item.tx.errors;
  const dropped = item.rx.dropped + item.tx.dropped;
  const meta = [
    item.mtu ? `MTU ${item.mtu}` : null,
    item.speedMbps ? `${item.speedMbps >= 1000 ? `${item.speedMbps / 1000} Gbps` : `${item.speedMbps} Mbps`}` : null,
    item.parent && item.kind === 'vlan' ? `induk ${item.parent}` : null,
    item.mac,
  ].filter(Boolean);
  return (
    <article className={`net-card tone-${stateTone[item.state]}`}>
      <div className="net-card-head">
        <strong>{item.name}</strong>
        <span className="net-kind">{kindLabels[item.kind]}{item.vlanId ? ` ${item.vlanId}` : ''}</span>
        <StateBadge state={item.state} text={item.stateText} />
      </div>
      {item.label ? <div className="net-label">{item.main ? '★ ' : ''}{item.label}</div> : null}
      <div className="net-ips">
        {item.addresses.length ? item.addresses.map((cidr) => <code key={cidr}>{cidr}</code>) : <span className="net-muted">Tanpa IP</span>}
      </div>
      <Rates rx={item.rx} tx={item.tx} />
      {meta.length ? <div className="net-meta">{meta.join(' · ')}</div> : null}
      {errors || dropped ? <div className="net-alert">{errors} error · {dropped} drop</div> : null}
      {item.stateText && item.state !== 'up' ? <div className="net-note">{item.stateText}</div> : null}
      <div className="net-card-actions">
        <button className="btn-ghost btn-sm" type="button" onClick={() => onTest({ target: item.testTarget ?? '', iface: item.name })}>Tes</button>
      </div>
    </article>
  );
}
