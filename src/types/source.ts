export type SourceType = 'OFFICIAL' | 'MEDIA' | 'RESEARCH' | 'SOCIAL';

export interface Source {
  name: string;
  type: SourceType;
  authority: number;
  enabled: boolean;
}
