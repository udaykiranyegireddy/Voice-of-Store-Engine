import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

type FadeUpProps = {
  children: ReactNode;
  delay?: number;
  duration?: number;
  y?: number;
  className?: string;
  style?: CSSProperties;
  as?: 'div' | 'section' | 'span' | 'h1' | 'h2' | 'h3' | 'p' | 'nav';
  once?: boolean;
};

export function FadeUp({
  children,
  delay = 0,
  duration = 0.7,
  y = 24,
  className,
  style,
  as = 'div',
  once = true,
}: FadeUpProps) {
  const Tag = as;
  const elementRef = useRef<HTMLElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
      if (once && entry.isIntersecting) observer.unobserve(element);
    }, { threshold: 0.2 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [once]);

  const animationStyle = {
    ...style,
    '--fade-up-delay': `${delay}s`,
    '--fade-up-duration': `${duration}s`,
    '--fade-up-distance': `${y}px`,
  } as CSSProperties;
  const setElementRef = (element: HTMLElement | null) => {
    elementRef.current = element;
  };

  return (
    <Tag
      ref={setElementRef}
      className={className}
      data-visible={isVisible ? 'true' : 'false'}
      style={animationStyle}
    >
      {children}
    </Tag>
  );
}
