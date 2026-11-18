export default async (_input, { db }) => {
  const weekAgo = Date.now() - 7 * 86400000
  const { docs } = await db.collection("tasks").list({ limit: 1000 })
  const old = docs.filter((d) => d.data.done && (d.data.doneAt ?? 0) < weekAgo).slice(0, 150)

  for (const d of old) await db.collection("tasks").delete(d.id)

  return { deleted: old.length }
}
