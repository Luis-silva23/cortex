import { cn } from '@/lib/cn';
import { CortexMark } from '@/components/ui/cortex-mark';

// Marca CÓRTEX: símbolo hexagonal (vetorizado da prancha oficial — brand/svg/cortex-mark.svg, ver docs/CORTEX/VISUAL_REFERENCES.md)
// ao lado do texto "CÓRTEX / LÓGICA DE NEGÓCIOS" em Montserrat. O símbolo é decorativo: o nome vem do texto.
export function CortexWordmark({
  as: Tag = 'span',
  tagline = true,
  size = 'md',
  mark = true,
  className,
}: {
  as?: 'span' | 'h1' | 'p';
  tagline?: boolean;
  size?: 'sm' | 'md' | 'lg';
  mark?: boolean;
  className?: string;
}) {
  const word = { sm: 'text-lg', md: 'text-xl', lg: 'text-3xl' }[size];
  const sub = { sm: 'text-[8px]', md: 'text-[9px]', lg: 'text-[11px]' }[size];
  const markHeight = { sm: 'h-7', md: 'h-8', lg: 'h-12' }[size];
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {mark && <CortexMark className={cn(markHeight, 'w-auto shrink-0')} />}
      <div className="flex flex-col leading-none">
        <Tag className={cn(word, 'font-bold tracking-[0.12em] text-foreground')}>CÓRTEX</Tag>
        {tagline && (
          <span className={cn(sub, 'mt-1 font-medium uppercase tracking-[0.32em] text-muted-foreground')}>
            Lógica de Negócios
          </span>
        )}
      </div>
    </div>
  );
}
