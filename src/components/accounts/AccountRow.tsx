import type { ReactNode } from 'react';

// One row of the account and profile pages: what the section is, beside its content.
export function Section({ id, title, help, children }: { id: string; title: string; help?: string; children: ReactNode }) {
  return (
    <section className="acct-row" aria-labelledby={id}>
      <div className="acct-row-label"><h2 id={id}>{title}</h2>{help && <p>{help}</p>}</div>
      <div className="acct-row-body">{children}</div>
    </section>
  );
}

const ROLE_NAMES: Record<string, string> = { contributor: 'Contributor', editor: 'Editor', admin: 'Administrator' };
export const roleName = (role: string) => ROLE_NAMES[role] ?? role;
