export default async (_input, { db, caller }) => {
  if (!caller) throw new Error("sign in to claim a task")
  const { docs } = await db.collection("tasks").list({ limit: 1000 })
  const open = docs.filter((d) => !d.data.done && !d.data.claimedBy)
  const task = open[open.length - 1]

  if (!task) return { task: null }
  await db.collection("tasks").update(task.id, { claimedBy: caller.email })

  return { task: { id: task.id, title: task.data.title } }
}
