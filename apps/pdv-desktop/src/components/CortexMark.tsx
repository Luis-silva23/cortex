// GERADO por brand/build-assets.js a partir de brand/svg/*.svg — não edite à mão (rode o script de novo).
// Símbolo hexagonal "C" do CÓRTEX. Decorativo por padrão (o texto da marca vem ao lado); passe decorative={false} para expô-lo a leitores de tela.
import onDark from '../assets/brand/cortex-mark.svg';
import onLight from '../assets/brand/cortex-mark-sobre-fundo-claro.svg';

export function CortexMark({ className, decorative = true, tone = 'onLight' }: { className?: string; decorative?: boolean; tone?: 'onLight' | 'onDark' }) {
  return <img src={tone === 'onDark' ? onDark : onLight} className={className} alt={decorative ? '' : 'CÓRTEX'} aria-hidden={decorative ? true : undefined} />;
}
