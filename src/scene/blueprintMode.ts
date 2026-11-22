import { createContext, useContext } from 'react'

// Whether the scene is drawn in the blueprint style, where nothing has a
// picture on it: lines over glass and flat color. Everything that would
// make or fetch a texture asks first and does without, so no pattern is
// baked, no cover art is fetched and none is sent to the graphics card.
export const BlueprintMode = createContext(false)

export const useBlueprintMode = () => useContext(BlueprintMode)
