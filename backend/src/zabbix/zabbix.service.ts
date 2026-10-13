import { Injectable, Logger } from '@nestjs/common';
import { IntegrationConfig } from '../settings/integration-config';

export type ZabbixItem = {
  itemid: string;
  hostid: string;
  key_: string;
  lastvalue: string;
  lastclock: string;
};

export type ZabbixProblem = {
  eventid: string;
  objectid: string;
  name: string;
  severity: string;
  clock: string;
};

@Injectable()
export class ZabbixService {
  private readonly logger = new Logger(ZabbixService.name);
  private auth: string | null = null;
  private requestId = 1;
  ready = false;
  version: string | null = null;
  lastError: string | null = null;
  private cfg = {
    url: process.env.ZABBIX_API_URL ?? 'http://127.0.0.1:8080/api_jsonrpc.php',
    user: process.env.ZABBIX_USER ?? 'Admin',
    password: process.env.ZABBIX_PASSWORD ?? '',
    token: process.env.ZABBIX_API_TOKEN ?? '',
    webhookUrl: process.env.ZABBIX_WEBHOOK_URL ?? '',
    webhookToken: process.env.ZABBIX_WEBHOOK_TOKEN ?? '',
  };

  constructor(private readonly integration: IntegrationConfig) {}

  async onModuleInit() {
    await this.refreshConfig();
  }

  async refreshConfig() {
    try {
      const next = await this.integration.read();
      const changed = next.zabbixApiUrl !== this.cfg.url
        || next.zabbixUser !== this.cfg.user
        || next.zabbixPassword !== this.cfg.password
        || next.zabbixApiToken !== this.cfg.token;
      this.cfg = {
        url: next.zabbixApiUrl,
        user: next.zabbixUser,
        password: next.zabbixPassword,
        token: next.zabbixApiToken,
        webhookUrl: next.webhookUrl,
        webhookToken: next.webhookToken,
      };
      if (changed) {
        this.auth = null;
        this.ready = false;
      }
    } catch (error) {
      this.logger.warn(`Konfigurasi Zabbix belum dimuat: ${error instanceof Error ? error.message : error}`);
    }
  }

  private url() {
    return this.cfg.url;
  }

  async ensureConnection() {
    try {
      this.version = await this.call<string>('apiinfo.version');
      if (!this.cfg.token) await this.login();
      this.ready = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.ready = false;
      this.auth = null;
      this.lastError = error instanceof Error ? error.message : 'Zabbix tidak terjangkau';
      return false;
    }
  }

  async probe(input: { url: string; user: string; password: string; token: string }) {
    try {
      const version = await this.raw<string>(input.url, 'apiinfo.version', {}, null);
      if (input.token) {
        await this.raw(input.url, 'user.get', { output: ['userid'], limit: 1 }, input.token);
      } else {
        try {
          await this.raw(input.url, 'user.login', { username: input.user, password: input.password }, null);
        } catch (error) {
          if (!String(error).toLowerCase().includes('username')) throw error;
          await this.raw(input.url, 'user.login', { user: input.user, password: input.password }, null);
        }
      }
      return { ok: true, version, error: null as string | null };
    } catch (error) {
      return {
        ok: false,
        version: null as string | null,
        error: error instanceof Error ? error.message : 'Zabbix tidak terjangkau',
      };
    }
  }

  async call<T>(method: string, params: Record<string, unknown> | unknown[] = {}, retried = false): Promise<T> {
    const token = this.cfg.token;
    const headers: Record<string, string> = { 'Content-Type': 'application/json-rpc' };
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.requestId++,
    };
    if (token && method !== 'apiinfo.version') {
      headers.Authorization = `Bearer ${token}`;
    } else if (this.auth && method !== 'user.login' && method !== 'apiinfo.version') {
      body.auth = this.auth;
    }

    let response: Response;
    try {
      response = await fetch(this.url(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      this.ready = false;
      const message = error instanceof Error ? error.message : 'Zabbix tidak terjangkau';
      this.lastError = message;
      throw new Error(message);
    }

    const json = (await response.json()) as {
      result?: T;
      error?: { message?: string; data?: string };
    };
    if (json.error) {
      const detail = json.error.data || json.error.message || 'Zabbix error';
      const sessionDead = /session|not authorised|not authorized|re-login/i.test(detail);
      if (sessionDead && !retried && !token && method !== 'user.login' && method !== 'apiinfo.version') {
        this.auth = null;
        await this.login();
        return this.call(method, params, true);
      }
      throw new Error(`${method}: ${detail}`);
    }
    return json.result as T;
  }

  private async raw<T>(url: string, method: string, params: Record<string, unknown>, token: string | null): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json-rpc' };
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params, id: 1 };
    if (token && method !== 'apiinfo.version') headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Zabbix tidak terjangkau');
    }
    const json = (await response.json()) as { result?: T; error?: { message?: string; data?: string } };
    if (json.error) throw new Error(json.error.data || json.error.message || 'Zabbix error');
    return json.result as T;
  }

  private async login() {
    this.auth = null;
    const username = this.cfg.user;
    const password = this.cfg.password;
    try {
      this.auth = await this.call<string>('user.login', { username, password });
    } catch (error) {
      if (String(error).toLowerCase().includes('username')) {
        this.auth = await this.call<string>('user.login', { user: username, password });
        return;
      }
      throw error;
    }
  }

  async snapshot(hostIds: string[]) {
    if (hostIds.length === 0) return { items: [] as ZabbixItem[], problems: [] as ZabbixProblem[] };
    const items = await this.call<ZabbixItem[]>('item.get', {
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock'],
      hostids: hostIds,
      filter: { key_: ['icmpping', 'icmppingsec', 'icmppingloss'] },
    });
    const problems = await this.call<ZabbixProblem[]>('problem.get', {
      output: ['eventid', 'objectid', 'name', 'severity', 'clock'],
      hostids: hostIds,
      recent: false,
      suppressed: false,
    });
    return { items, problems };
  }

  async history(itemId: string, from: number) {
    const rows = await this.call<Array<{ clock: string; value: string }>>('history.get', {
      output: 'extend',
      history: 0,
      itemids: [itemId],
      time_from: from,
      sortfield: 'clock',
      sortorder: 'ASC',
    });
    return thin(rows).map((row) => ({ clock: Number(row.clock), value: Number(row.value) }));
  }

  async hostItems(hostId: string) {
    return this.call<Array<{ itemid: string; key_: string; name: string; value_type: string; units: string }>>('item.get', {
      hostids: [hostId],
      output: ['itemid', 'key_', 'name', 'value_type', 'units'],
      filter: { value_type: ['0', '3'] },
    });
  }

  async interfaceItems(hostId: string) {
    return this.call<Array<{ itemid: string; key_: string; name: string; value_type: string; units: string }>>('item.get', {
      hostids: [hostId],
      output: ['itemid', 'key_', 'name', 'value_type', 'units'],
      search: { key_: 'net.if.' },
      startSearch: true,
    });
  }

  async interfaceLastValues(hostIds: string[]) {
    if (!hostIds.length) return [] as ZabbixItem[];
    return this.call<ZabbixItem[]>('item.get', {
      hostids: hostIds,
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock'],
      search: { key_: 'net.if.' },
      startSearch: true,
    });
  }

  async series(itemIds: string[], from: number, useTrend: boolean, historyType = 0, until?: number) {
    const grouped = new Map<string, Array<{ t: number; v: number }>>();
    if (itemIds.length === 0) return grouped;
    const bound = until === undefined ? {} : { time_till: until };
    if (useTrend) {
      const rows = await this.call<Array<{ itemid: string; clock: string; value_avg: string }>>('trend.get', {
        output: ['itemid', 'clock', 'value_avg'],
        itemids: itemIds,
        time_from: from,
        sortfield: 'clock',
        sortorder: 'ASC',
        ...bound,
      });
      this.collectSeries(grouped, rows, true);
      return grouped;
    }
    const end = until ?? Math.floor(Date.now() / 1000);
    for (let offset = 0; offset < itemIds.length; offset += 8) {
      const ids = itemIds.slice(offset, offset + 8);
      let cursor = from;
      const seen = new Set<string>();
      while (cursor <= end) {
        const rows = await this.call<Array<{ itemid: string; clock: string; value: string }>>('history.get', {
          output: ['itemid', 'clock', 'value'],
          history: historyType,
          itemids: ids,
          time_from: cursor,
          time_till: end,
          sortfield: 'clock',
          sortorder: 'ASC',
          limit: 5000,
        });
        if (!rows.length) break;
        let last = cursor;
        for (const row of rows) {
          const stamp = `${row.itemid}:${row.clock}`;
          const clock = Number(row.clock);
          if (clock > last) last = clock;
          if (seen.has(stamp)) continue;
          seen.add(stamp);
          const list = grouped.get(row.itemid) ?? [];
          list.push({ t: clock * 1000, v: Number(row.value) });
          grouped.set(row.itemid, list);
        }
        if (rows.length < 5000 || last <= cursor) break;
        cursor = last;
      }
    }
    return grouped;
  }

  private collectSeries(grouped: Map<string, Array<{ t: number; v: number }>>, rows: Array<{ itemid: string; clock: string; value_avg: string }>, trend: boolean) {
    for (const row of rows) {
      const value = trend ? Number(row.value_avg) : Number((row as { value?: string }).value);
      const list = grouped.get(row.itemid) ?? [];
      list.push({ t: Number(row.clock) * 1000, v: value });
      grouped.set(row.itemid, list);
    }
  }

  async trends(itemId: string, from: number) {
    const rows = await this.call<Array<{ clock: string; value_avg: string }>>('trend.get', {
      output: ['clock', 'value_avg'],
      itemids: [itemId],
      time_from: from,
      sortfield: 'clock',
      sortorder: 'ASC',
    });
    return thin(rows).map((row) => ({ clock: Number(row.clock), value: Number(row.value_avg) }));
  }

  async acknowledge(eventId: string) {
    await this.call('event.acknowledge', {
      eventids: [eventId],
      action: 6,
      message: 'Diakui dari Kalimasada NMS',
    });
  }

  async ensureWebhook() {
    if (!this.ready) return false;
    try {
      const url = this.cfg.webhookUrl;
      const token = this.cfg.webhookToken;
      if (!url || !token) return false;
      const name = 'Kalimasada';
      const existing = await this.call<Array<{ mediatypeid: string }>>('mediatype.get', {
        filter: { name: [name] },
        output: ['mediatypeid'],
      });
      const script = [
        'try {',
        '  var params = JSON.parse(value);',
        '  var req = new HttpRequest();',
        "  req.addHeader('Content-Type: application/json');",
        "  req.addHeader('X-Webhook-Token: ' + params.token);",
        '  var resp = req.post(params.url, JSON.stringify({ event_id: params.event_id }));',
        '  if (req.getStatus() < 200 || req.getStatus() >= 300) throw "HTTP " + req.getStatus() + " " + resp;',
        "  return 'OK';",
        '} catch (error) {',
        "  Zabbix.log(3, 'Kalimasada webhook: ' + error);",
        '  throw error;',
        '}',
      ].join('\n');
      const parameters = [
        { name: 'url', value: url },
        { name: 'token', value: token },
        { name: 'event_id', value: '{EVENT.ID}' },
      ];
      let mediatypeid = existing[0]?.mediatypeid;
      if (!mediatypeid) {
        const created = await this.call<{ mediatypeids: string[] }>('mediatype.create', {
          type: 4,
          name,
          status: 0,
          script,
          timeout: '15s',
          parameters,
        });
        mediatypeid = created.mediatypeids[0];
      } else {
        await this.call('mediatype.update', { mediatypeid, script, parameters, status: 0 });
      }
      await this.ensureAction(mediatypeid);
      return true;
    } catch (error) {
      this.logger.warn(`Webhook Zabbix belum terpasang: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  private async ensureAction(mediatypeid: string) {
    const actions = await this.call<Array<{ actionid: string }>>('action.get', {
      filter: { name: ['Kalimasada webhook'] },
      output: ['actionid'],
    });
    if (actions[0]) return;
    const users = await this.call<Array<{ userid: string }>>('user.get', {
      output: ['userid'],
      filter: { username: [this.cfg.user] },
    });
    const userid = users[0]?.userid ?? '1';
    const medias = await this.call<Array<{ mediatypeid: string; sendto: string[] }>>('usermedia.get', {
      userids: [userid],
    }).catch(() => []);
    const hasMedia = Array.isArray(medias) && medias.some((media) => media.mediatypeid === mediatypeid);
    if (!hasMedia) {
      const current = await this.call<Array<{ medias?: Array<Record<string, unknown>> }>>('user.get', {
        userids: [userid],
        selectMedias: 'extend',
      });
      const kept = (current[0]?.medias ?? []).map((media) => ({
        mediatypeid: String(media.mediatypeid),
        sendto: Array.isArray(media.sendto) ? String(media.sendto[0] ?? 'kalimasada') : String(media.sendto ?? 'kalimasada'),
        active: Number(media.active ?? 0),
        severity: Number(media.severity ?? 63),
        period: String(media.period ?? '1-7,00:00-24:00'),
      }));
      kept.push({
        mediatypeid,
        sendto: 'kalimasada',
        active: 0,
        severity: 63,
        period: '1-7,00:00-24:00',
      });
      await this.call('user.update', { userid, medias: kept });
    }
    const groups = await this.call<Array<{ groupid: string }>>('hostgroup.get', {
      filter: { name: ['Kalimasada'] },
      output: ['groupid'],
    });
    const groupId = groups[0]?.groupid;
    if (!groupId) return;
    await this.call('action.create', {
      name: 'Kalimasada webhook',
      eventsource: 0,
      status: 0,
      esc_period: '1h',
      filter: { evaltype: 0, conditions: [{ conditiontype: 0, operator: 0, value: groupId }] },
      operations: [{
        operationtype: 0,
        esc_step_from: 1,
        esc_step_to: 1,
        opmessage_usr: [{ userid }],
        opmessage: { default_msg: 1, mediatypeid },
      }],
      recovery_operations: [{
        operationtype: 0,
        opmessage_usr: [{ userid }],
        opmessage: { default_msg: 1, mediatypeid },
      }],
    });
  }
}

function thin<T>(rows: T[], max = 400) {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  return rows.filter((_, index) => index % step === 0);
}
