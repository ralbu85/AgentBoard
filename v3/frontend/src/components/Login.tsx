import { useState, type FormEvent } from 'react'
import { api } from '../api'

interface Props {
  onLogin: () => void
}

export function Login({ onLogin }: Props) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const res = await api.login(pw)
    if (res.ok) onLogin()
    else setError(true)
  }

  return (
    <div className="login-screen">
      <form className="login-form" onSubmit={submit}>
        <h1>TermHub</h1>
        <input
          type="password"
          value={pw}
          onChange={(e) => { setPw(e.target.value); setError(false) }}
          placeholder="Password"
          autoFocus
        />
        <button type="submit" className="btn btn-primary">Login</button>
        {error && <p className="error">Invalid password</p>}
      </form>
    </div>
  )
}
