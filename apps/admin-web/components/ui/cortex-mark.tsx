// GERADO por brand/build-assets.js a partir de brand/svg/*.svg — não edite à mão (rode o script de novo).
// Símbolo hexagonal "C" do CÓRTEX. Decorativo por padrão (o texto da marca vem ao lado); passe decorative={false} para expô-lo a leitores de tela.
/* eslint-disable @next/next/no-img-element */
import onDark from './brand-assets/cortex-mark.svg';
import onLight from './brand-assets/cortex-mark-sobre-fundo-claro.svg';

export function CortexMark({ className = '', decorative = true }: { className?: string; decorative?: boolean }) {
  return (
    <>
      <img src={onDark.src} className={`${className} hidden dark:block`} alt={decorative ? '' : 'CÓRTEX'} aria-hidden={decorative ? true : undefined} />
      <img src={onLight.src} className={`${className} block dark:hidden`} alt={decorative ? '' : 'CÓRTEX'} aria-hidden={decorative ? true : undefined} />
    </>
  );
}
