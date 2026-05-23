import { useTranslation } from 'react-i18next';
import type { LayerType } from '../lib/api-types';
import { cn } from '../lib/cn';

/**
 * Small label that shows a layer's type.
 *
 * Colors come from design tokens (the shadcn palette in
 * `apps/web/src/index.css`). No hardcoded hex values — every variant
 * maps to a `bg-…/text-…` pair already defined for the theme.
 *
 * Used by `LayerSwitcher`, `MyLayersPage`, and `LayerSettingsPage`
 * headers.
 */
export interface LayerTypeBadgeProps {
  readonly type: LayerType;
  readonly className?: string;
}

const VARIANTS: Record<LayerType, string> = {
  personal: 'bg-primary/10 text-primary border-primary/30',
  project: 'bg-accent text-accent-foreground border-border',
  group: 'bg-secondary text-secondary-foreground border-border',
  everyone: 'bg-muted text-muted-foreground border-border',
};

export function LayerTypeBadge(props: LayerTypeBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const label = t(`layer.type.${props.type}`);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        VARIANTS[props.type],
        props.className,
      )}
    >
      {label}
    </span>
  );
}
