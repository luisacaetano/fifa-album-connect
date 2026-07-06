import { useEffect, useState } from "react";
import { initials } from "@/data/players";

type Props = {
  name: string;
  photo?: string | null;
  size?: number;
  className?: string;
};

// Foto do colecionador, ou as iniciais sobre o gradiente FIFA quando não há foto.
export function Avatar({ name, photo, size = 40, className = "" }: Props) {
  const style = { width: size, height: size };
  // Se a foto falhar ao carregar (ex.: URL do Google que retorna 403),
  // caímos para as iniciais em vez de exibir o ícone de imagem quebrada.
  const [failed, setFailed] = useState(false);
  // Reseta o estado de erro quando a URL da foto muda.
  useEffect(() => setFailed(false), [photo]);

  if (photo && !failed) {
    return (
      <img
        src={photo}
        alt={name}
        style={style}
        // Fotos do Google (lh3.googleusercontent.com) devolvem 403 quando o
        // navegador envia o cabeçalho Referer; "no-referrer" evita isso.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <span style={style} className={`grid shrink-0 place-items-center rounded-full bg-fifa-gradient font-display text-white ${className}`} aria-hidden>
      <span style={{ fontSize: Math.round(size * 0.4) }}>{initials(name)}</span>
    </span>
  );
}
