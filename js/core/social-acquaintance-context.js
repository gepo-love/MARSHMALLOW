import { loadContactGroupsConfig } from './contact-groups.js';
import { loadRelationshipNetwork } from './relationship-network.js';
import { findLedgerEntry, loadAcquaintanceLedger } from './acquaintance-ledger.js';
import { canPhoneCharactersKnowEachOther } from './phone-social-eligibility.js';

function nameOf(row) {
  return String(row?.customNickname || row?.name || row?.realName || row?.id || '').trim();
}

export async function buildSocialAcquaintancePromptBlock(characters = [], userId = '') {
  const rows = (Array.isArray(characters) ? characters : [])
    .filter((row) => row?.id)
    .slice(0, 24);
  if (!rows.length) return '';
  const [relationshipNet, contactGroupsConfig, ledger] = await Promise.all([
    loadRelationshipNetwork(userId).catch(() => null),
    loadContactGroupsConfig().catch(() => ({ groups: [] })),
    loadAcquaintanceLedger().catch(() => ({ entries: [] })),
  ]);
  const knownLines = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (!canPhoneCharactersKnowEachOther(
        a,
        b,
        relationshipNet,
        contactGroupsConfig,
        ledger,
      )) continue;
      const dynamic = findLedgerEntry(ledger, a.id, b.id);
      const relationLabel = String(a.relationships?.[b.id] || b.relationships?.[a.id] || '').trim();
      const label = dynamic?.label || relationLabel || (dynamic?.level === 'met' ? '刚认识' : '认识');
      knownLines.push(`- ${a.id}:${nameOf(a)} ↔ ${b.id}:${nameOf(b)}：${label}`);
    }
  }
  return [
    '【角色互识边界 · 硬规则】',
    '下列仅列出本轮通讯录角色之间已建立的认识关系。未列出的两名角色默认互不认识：不得互相点名、回复、调侃、爆料或表现得熟悉；在公共平台偶遇时只能像普通陌生网友一样互动。',
    '标为“刚认识”或仅“认识”的关系要克制，不得直接写成多年好友。普通路人账号不属于通讯录角色，可正常参与公共讨论。',
    knownLines.length ? knownLines.join('\n') : '本轮通讯录角色之间没有已建立的认识关系。',
  ].join('\n');
}
