import { dev } from "$app/environment"
import { base } from "$app/paths"

export const baseUrl = dev ? '/' : base + '/'

export function solvedUrl(relative_url?: string): string {
    const relative = relative_url ?? '';
    const url = `${baseUrl}${relative}`
    
    return url
}
