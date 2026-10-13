export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {status.toUpperCase()}
    </span>
  );
}
