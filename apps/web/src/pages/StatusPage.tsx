import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ApiError, fetchStatus, type StatusResponse } from '../lib/api';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; errorKey: string }
  | { kind: 'ready'; data: StatusResponse };

export function StatusPage(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchStatus()
      .then((data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const errorKey = err instanceof ApiError ? err.errorKey : 'errors.network';
        setState({ kind: 'error', errorKey });
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('status.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p>{t('common.loading')}</p>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'error') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('status.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="alert" className="text-destructive">
            {t(state.errorKey, { defaultValue: t('errors.network') })}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={(): void => setState({ kind: 'loading' })}
          >
            {t('common.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { data } = state;
  const rows: Array<{ labelKey: string; value: string }> = [
    { labelKey: 'status.fields.version', value: data.version },
    { labelKey: 'status.fields.phase', value: data.phase },
    { labelKey: 'status.fields.dataDir', value: data.dataDir },
    {
      labelKey: 'status.fields.configFile',
      value: data.configFile ?? t('status.fields.configFileNone'),
    },
    {
      labelKey: 'status.fields.sqliteSchema',
      value: data.sqlite.schemaVersion ?? t('status.fields.sqliteSchemaNone'),
    },
    {
      labelKey: 'status.fields.lancedbTables',
      value: String(data.lancedb.tables.length),
    },
    {
      labelKey: 'status.fields.busAdapter',
      value: data.bus.adapter,
    },
    { labelKey: 'status.fields.busEvents', value: String(data.bus.events) },
    { labelKey: 'status.fields.llmEndpoint', value: data.llm.endpoint },
    { labelKey: 'status.fields.llmModel', value: data.llm.defaultModel },
    { labelKey: 'status.fields.llmCalls', value: String(data.llm.calls) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('status.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">
          {data.ok ? t('status.healthy') : t('status.unhealthy')}
        </p>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-[max-content_1fr]">
          {rows.map((row) => (
            <div key={row.labelKey} className="contents">
              <dt className="text-sm font-medium text-muted-foreground">{t(row.labelKey)}</dt>
              <dd className="text-sm font-mono break-all">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
