import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ApiError, postChat, type ChatResponse } from '../lib/api';

type ChatState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; errorKey: string }
  | { kind: 'success'; response: ChatResponse };

/**
 * Single-turn chat form.
 *
 * Keyboard: pressing Enter inside the textarea submits the form; Shift+Enter
 * inserts a newline. This matches the convention used in most chat UIs and
 * is documented in `docs/dev/architecture/i18n.md` (chat keyboard section).
 */
export function ChatPage(): JSX.Element {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [model, setModel] = useState('');
  const [state, setState] = useState<ChatState>({ kind: 'idle' });

  async function submit(): Promise<void> {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setState({ kind: 'error', errorKey: 'errors.chat.empty' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      const payload: { message: string; model?: string } = { message: trimmed };
      if (model.trim().length > 0) payload.model = model.trim();
      const response = await postChat(payload);
      setState({ kind: 'success', response });
    } catch (err: unknown) {
      const errorKey = err instanceof ApiError ? err.errorKey : 'errors.network';
      setState({ kind: 'error', errorKey });
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const sending = state.kind === 'sending';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('chat.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">{t('chat.description')}</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="chat-message">{t('chat.messageLabel')}</Label>
              <Textarea
                id="chat-message"
                name="message"
                value={message}
                onChange={(e): void => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('chat.placeholder')}
                disabled={sending}
                rows={4}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-model">{t('chat.modelLabel')}</Label>
              <Input
                id="chat-model"
                name="model"
                value={model}
                onChange={(e): void => setModel(e.target.value)}
                placeholder={t('chat.modelPlaceholder')}
                disabled={sending}
              />
            </div>
            <div>
              <Button type="submit" disabled={sending}>
                {sending ? t('chat.sending') : t('chat.send')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {state.kind === 'error' ? (
        <Card>
          <CardContent className="pt-6">
            <p role="alert" className="text-destructive">
              {t(state.errorKey, { defaultValue: t('errors.network') })}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {state.kind === 'success' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('chat.responseTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="whitespace-pre-wrap">{state.response.content}</p>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-muted-foreground">{t('chat.metaModel')}</dt>
              <dd className="font-mono">{state.response.model}</dd>
              <dt className="text-muted-foreground">{t('chat.metaTokensIn')}</dt>
              <dd className="font-mono">{state.response.tokensIn}</dd>
              <dt className="text-muted-foreground">{t('chat.metaTokensOut')}</dt>
              <dd className="font-mono">{state.response.tokensOut}</dd>
              <dt className="text-muted-foreground">{t('chat.metaCorrelationId')}</dt>
              <dd className="font-mono break-all">{state.response.correlationId}</dd>
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
