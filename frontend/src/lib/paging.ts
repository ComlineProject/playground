import { dev } from "$app/environment"
import { base } from "$app/paths"

export const baseUrl = dev ? '/' : base + '/'

export function solvedUrl(relative_url: string): string {
    const url = `${baseUrl}${relative_url}`

    return url
}
