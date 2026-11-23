import type { RouteRule } from '../db.ts';

const domainOf = (a: string) => a.slice(a.lastIndexOf('@') + 1).toLowerCase();
const norm = (d: string) => d.trim().toLowerCase().replace(/^@/, '');

/** A rule matches when every non-empty condition matches (any value within a condition). Empty rule = match all. */
export function ruleMatches(rule: RouteRule, env: { mailFrom: string; rcptTo: string[] }): boolean {
  const m = rule.match;
  if (m.senders.length && !m.senders.some((s) => s.trim().toLowerCase() === env.mailFrom.toLowerCase())) return false;
  if (m.senderDomains.length && !m.senderDomains.map(norm).includes(domainOf(env.mailFrom))) return false;
  if (m.recipientDomains.length) {
    const wanted = m.recipientDomains.map(norm);
    if (!env.rcptTo.some((r) => wanted.includes(domainOf(r)))) return false;
  }
  return true;
}

/**
 * Walk rules in order and collect destinations of each matching rule (fan-out) until a rule with
 * "stop" matches. If nothing matched, use the default destination.
 */
export function resolveDestinations(rules: RouteRule[], defaultId: string | null, env: { mailFrom: string; rcptTo: string[] }): string[] {
  const out: string[] = [];
  let matched = false;
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, env)) continue;
    matched = true;
    for (const id of rule.destinationIds) if (!out.includes(id)) out.push(id);
    if (rule.stop) break;
  }
  if (!matched && defaultId) out.push(defaultId);
  return out;
}
