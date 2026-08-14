export const initUrlWidget = (onLoad: (url: string) => void): void => {
  const input = document.querySelector<HTMLInputElement>('#tileset-url')
  const btn = document.querySelector<HTMLButtonElement>('#url-load-btn')

  if (!input || !btn) {
    throw new Error('URL widget elements not found')
  }

  const params = new URLSearchParams(window.location.search)
  input.value =
    params.get('tileset') ?? `${import.meta.env.BASE_URL}data/add_spheres/tileset.json`

  const load = () => {
    const url = input.value.trim()
    if (url) onLoad(url)
  }

  btn.addEventListener('click', load)
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') load()
  })
}
